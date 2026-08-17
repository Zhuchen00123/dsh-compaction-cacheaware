/**
 * Reasonix-style cache-aware compaction engine for DSH.
 *
 * Implements the official `@deepseek-ai/dsh-compaction` seam:
 *   - `compactIfNeeded` for automatic pressure and provider-confirmed overflow,
 *   - `compactNow` for manual `/compact`,
 *   - `compactRegion` for programmatic range compaction.
 *
 * The durable transaction mirrors DSH's official `compaction/start → summary →
 * replace → end` bracket while adding Reasonix's checkpoint acceptance checks
 * (≤50% ceiling, below compact_ratio, exceptional fixed-prefix path).
 *
 * @module dsh-compaction-cacheaware/engine
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  BlockAssembler,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmError,
  contentHasImage,
  createUserMessage,
  errorChain,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, TokenUsage, ToolSchema, UserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { resolveCompactSpec, resolveConfig, type CacheAwareCompactionConfig, type CacheAwareCompactSpec, type ResolvedCacheAwareConfig } from './config.js'
import { REASONIX_SUMMARY_INSTRUCTION, frameSummary } from './prompt.js'
import { acceptCheckpointCandidate, fixedPrefixTokens, selectOverflowRange, selectReasonixRange } from './selection.js'

export type { CacheAwareCompactionConfig, ResolvedCacheAwareConfig, CacheAwareCompactSpec } from './config.js'

/** Target-specific pressure configuration failure eligible for warning suppression. */
export class TargetPressureConfigError extends Error {
  readonly targetKey: string
  constructor(targetKey: string, message: string) {
    super(message)
    this.name = 'TargetPressureConfigError'
    this.targetKey = targetKey
  }
}

/** Summarizer input: replayed conversation prefix, aligned to the provider cache. */
export interface SummarizationInput {
  readonly system?: string
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}

/** Safe summary plus the exact auxiliary call envelope. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & (
  | { rawOutput: ContentBlock[]; llmStreamCall: true }
  | { rawOutput?: ContentBlock[]; llmStreamCall?: never }
)

interface CompactionTransactionOptions {
  readonly owner: 'current-turn' | null
  readonly stability: 'whole-surface' | 'selected-span'
  readonly trigger: string
  readonly force: boolean
  readonly flush?: () => Promise<void>
  readonly sourceCommandId?: CommandId
}

class SurfaceChangedError extends Error {}

function finishError(finish: import('@deepseek-ai/dsh-llm').FinishReason | undefined): Error | undefined {
  if (!finish) return undefined
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message)
      ;(error as Error & { code?: string }).code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)')
      ;(error as Error & { code?: string }).code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

function summaryText(blocks: readonly ContentBlock[]): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}

function routedTarget(session: Session): { provider: string; model: string } | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined
  return { provider: config.provider, model: config.model }
}

function conversationTarget(agent: Agent): { provider: string; model: string } | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0 || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

/** Inspect open-turn, unmatched-compaction, and latest seed-boundary state. */
function inspectCompactionEntryState(events: readonly SessionEvent[]): {
  openTurn: number | null
  unmatchedCompactionStart: SessionEvent | undefined
  latestEndSeedSeq: number | undefined
} {
  let openTurn: number | null = null
  let openTurnStateKnown = false
  let unmatchedCompactionStart: SessionEvent | undefined
  let compactionEntryStateKnown = false
  let latestEndSeedSeq: number | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') latestEndSeedSeq = event.seq
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryStateKnown = true
      } else if (event.type === 'compaction/end') {
        compactionEntryStateKnown = true
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = (event.data as { turn: number }).turn
        openTurnStateKnown = true
      } else if (event.type === 'turn/end') {
        openTurnStateKnown = true
      }
    }
    if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined) break
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}

function assertCompactionInactive(unmatchedCompactionStart: SessionEvent | undefined, latestEndSeedSeq: number | undefined, stage: string): void {
  if (unmatchedCompactionStart === undefined || (latestEndSeedSeq !== undefined && latestEndSeedSeq > unmatchedCompactionStart.seq)) return
  throw new ManualCompactionError('busy', `${stage}: compaction already in progress; the session compaction lock is already active`)
}

function sanitizeSummarizationMessage(message: Message): Message {
  if (message.role !== 'assistant' || !message.content.some((block) => block.type === 'reasoning')) return message

  // Reasoning blocks are provider-private response items. Replaying their
  // encrypted signatures in a fresh compaction request is not portable: the
  // OpenAI Responses API may reject them when the new request has reasoning
  // disabled (as Console Go does with invalid_prompt). They are not needed to
  // preserve the user-visible/tool transcript, so drop them and invalidate the
  // adapter replay envelope while retaining text and tool-call blocks.
  return {
    ...message,
    content: message.content.filter((block) => block.type !== 'reasoning'),
    source: message.source.kind === 'model'
      ? { kind: 'model', provider: message.source.provider, model: message.source.model }
      : message.source,
  }
}

function buildSummarizationInput(session: Session, shadowedSeqs: readonly number[]): SummarizationInput {
  const header = session.requestHeader()
  const events = session.events
  const regionMessages = shadowedSeqs
    .map((seq) => session.deriveEventMessage(events[seq]!))
    .filter((message): message is Message => message !== null)
    .map(sanitizeSummarizationMessage)
  return {
    ...(header?.system === undefined ? {} : { system: header.system }),
    ...(header?.tools === undefined ? {} : { tools: header.tools }),
    messages: regionMessages,
  }
}

/**
 * The DSH compaction backend plugin. Mount it in a preset/compaction realm in
 * place of `@deepseek-ai/dsh-compaction-basic`.
 */
export class CacheAwareCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions'] as const

  static Config = z.object({
    compactRatio: z.number(),
    checkpointCeilingRatio: z.number(),
    recentTailRatio: z.number(),
    recentTailMinTokens: z.number(),
    recentTailMaxTokens: z.number(),
    summaryMaxTokens: z.number(),
    exceptionalMinSavingsRatio: z.number(),
    minRecentKeep: z.number(),
    minCompactMessages: z.number(),
    maxPinnedFirstUserTokens: z.number(),
    pinnedFirstUserWindowFrac: z.number(),
    protocolReserveTokens: z.number(),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    auto: z.boolean(),
  })

  readonly config: ResolvedCacheAwareConfig
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()

  constructor(ctx: Context, config: CacheAwareCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(`compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes (seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`)
    }

    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error) {
          if (error instanceof TargetPressureConfigError) {
            // Warn once per target, then continue the turn.
            ctx.logger.warn(`step compaction configuration failed for ${error.targetKey}: ${error.message}; continuing the turn`)
          } else {
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
          }
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const retries = this.overflowRetries.get(agent) ?? 0
      const maxOverflowRetries = 1
      if (retries >= maxOverflowRetries) return next()
      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(`context-overflow compaction failed after durable surface progress: ${message}; retrying from the replacement surface`)
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(`context-overflow compaction failed: ${message}; ${signal.aborted ? 'cancellation prevents retry' : 'preserving the original request error'}`)
        return next()
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  private isRetriableSummarizeError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error)
    if (/checkpoint rejected|summary is not smaller|SurfaceChanged|would not reduce tokens/i.test(msg)) return false
    const code = (error as { code?: unknown })?.code ?? (error as { cause?: { code?: unknown } })?.cause?.code
    if (typeof code === 'string' && /proxy_error|QUOTA|BAD_REQUEST|exhausted|unreachable|MAX_TOKENS|UNSUPPORTED_CONTENT/i.test(code)) return true
    if (/all upstreams exhausted|unreachable|proxy_error|BAD_REQUEST|QUOTA|ECONN|ETIMEDOUT|ENOTFOUND|exhausted/i.test(msg)) return true
    // LlmError transport failures are retriable; keep logic conservative
    if (error instanceof LlmError) return /proxy_error|exhausted|unreachable/i.test((error as { code?: string }).code ?? '') || /proxy_error|exhausted|unreachable/i.test(msg)
    return false
  }

  private async buildSummarizationCandidates(agent: Agent, signal?: AbortSignal): Promise<Array<{ provider: string; model: string }>> {
    const candidates: Array<{ provider: string; model: string }> = []
    const seen = new Set<string>()
    const push = (provider: string, model: string): void => {
      if (!provider || !model) return
      const key = `${provider}\0${model}`
      if (seen.has(key)) return
      seen.add(key)
      candidates.push({ provider, model })
    }
    if (this.config.summarizationProvider && this.config.summarizationModel) {
      push(this.config.summarizationProvider, this.config.summarizationModel)
    }
    const conv = conversationTarget(agent)
    if (conv) push(conv.provider, conv.model)
    try {
      const providers = this.ctx.llm.listProviders() as unknown as Array<{ provider?: string; id?: string } | string>
      for (const entry of providers) {
        const providerName = typeof entry === 'string' ? entry : (entry.provider ?? entry.id ?? '')
        if (!providerName) continue
        try {
          const models = (await this.ctx.llm.listModels(providerName)) as unknown as Array<{ id?: string; provider?: string }>
          for (const m of models) {
            const modelId = m.id ?? ''
            if (!modelId) continue
            try {
              const info = await this.ctx.llm.resolveModelInfo(providerName, modelId, signal)
              if (info?.context?.contextWindow) {
                push(providerName, modelId)
                break
              }
            } catch {
              // try next model
            }
          }
        } catch {
          // provider discovery failed, continue
        }
        if (candidates.length >= 4) break
      }
    } catch {
      // discovery unavailable
    }
    return candidates
  }

  private async summarizeWithCandidate(
    provider: string,
    model: string,
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const assembler = new BlockAssembler()
    const messages = [
      ...input.messages,
      createUserMessage({
        content: [{ type: 'text', text: REASONIX_SUMMARY_INSTRUCTION }],
        source: { kind: 'plugin', plugin: 'dsh-compaction-cacheaware' },
      }),
    ]
    const options = {
      provider,
      model,
      messages,
      ...(input.system === undefined ? {} : { system: input.system }),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens: this.config.summaryMaxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction' as const,
      ...(signal === undefined ? {} : { signal }),
    }
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    const error = finishError(assembler.finish)
    if (error !== undefined) throw error
    const rawOutput = assembler.blocks()
    const summary = summaryText(rawOutput)
    if (!summary.some((block) => block.text.trim().length > 0)) throw new Error('summarization produced no text summary content')
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: options.provider,
      model: options.model,
      maxTokens: this.config.summaryMaxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    }
  }

  protected async summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    const candidates = await this.buildSummarizationCandidates(agent, signal)
    if (candidates.length === 0) {
      throw new Error('no provider/model available for summarization: set CacheAwareCompactionConfig summarization fields, route one request, or set both AgentOptions fields')
    }
    const attempts: string[] = []
    let lastError: unknown
    for (const candidate of candidates.slice(0, 3)) {
      try {
        return await this.summarizeWithCandidate(candidate.provider, candidate.model, input, agent, signal)
      } catch (error) {
        lastError = error
        const msg = error instanceof Error ? error.message : String(error)
        attempts.push(`${candidate.provider}/${candidate.model}: ${msg}`)
        if (!this.isRetriableSummarizeError(error)) throw error
        this.ctx.logger.warn(`compact summarize ${candidate.provider}/${candidate.model} failed: ${msg}; trying next candidate`)
        signal?.throwIfAborted()
      }
    }
    if (lastError !== undefined) {
      // Preserve every candidate failure in the durable compaction/end error.
      // Throwing only the last error made a multi-provider failure look like a
      // single unexplained summary failure in the session log.
      const aggregate = new Error(`all summarization candidates failed: ${attempts.join('; ')}`, { cause: lastError })
      const code = (lastError as { code?: unknown })?.code
      if (typeof code === 'string') (aggregate as Error & { code?: string }).code = code
      throw aggregate
    }
    throw new Error(`all summarization candidates exhausted: ${attempts.join('; ')}`)
  }

  async compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    const prune = this.ctx.get('toolResultPruner')
    if (trigger === 'context-overflow') {
      if (prune !== undefined) {
        prune.pruneSession(agent.session)
        measurement = meter.measure(agent.session)
      }
      const range = await this._selectRange(agent, measurement, true)
      if (range === null) return null
      return this._compactSurfaceRegion(agent, range, {
        owner: 'current-turn',
        stability: 'whole-surface',
        trigger,
        force: true,
      }, signal)
    }

    // pressure
    const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context
    const targetKey = `${target.provider}/${target.model}`
    if (context === undefined) {
      throw new TargetPressureConfigError(targetKey, `CacheAwareCompaction: no context capacity for ${targetKey}; configure contextWindow on that adapter model`)
    }
    const spec = resolveCompactSpec(this.config, context.contextWindow)
    if (measurement.totalTokens < spec.thresholdTokens) return null
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null
    const range = await this._selectRange(agent, measurement, false)
    if (range === null) return null
    const result = await this._compactSurfaceRegion(agent, range, {
      owner: 'current-turn',
      stability: 'whole-surface',
      trigger,
      force: false,
    }, signal)
    // Reasonix runs exactly one summary transaction; if it still sits above the
    // trigger we report the blocked state instead of paying for more summaries.
    const after = meter.measure(agent.session)
    if (after.totalTokens >= spec.thresholdTokens) {
      throw new Error(`compaction still above threshold after one Reasonix summary (${after.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`)
    }
    return result
  }

  async compactRegion(start: number, end: number, agent: Agent, signal?: AbortSignal): Promise<CompactionResult> {
    const range = this._rangeFromSeqs(agent, start, end)
    return this._compactSurfaceRegion(agent, range, {
      owner: 'current-turn',
      stability: 'whole-surface',
      trigger: 'region',
      force: true,
    }, signal)
  }

  async compactNow(agent: Agent, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return await agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const measurement = this.ctx.tokenMeter.measure(agent.session)
          const range = await this._selectRange(agent, measurement, true)
          if (range === null) return null
          return await this._compactSurfaceRegion(agent, range, {
            owner: null,
            stability: 'selected-span',
            trigger: 'manual',
            force: true,
            ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
            flush: async () => {
              await this.ctx.sessions.flush(agent.session)
            },
          }, operationSignal)
        } catch (error) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error })
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error) {
      if (error instanceof ManualCompactionError) throw error
      throw new ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work', { cause: error })
    }
  }

  private async _selectRange(agent: Agent, measurement: ReturnType<typeof this.ctx.tokenMeter.measure>, force: boolean): Promise<ReturnType<typeof selectReasonixRange>> {
    const target = routedTarget(agent.session)
    const fallback = conversationTarget(agent)
    const route = target ?? fallback
    if (route === undefined) return null
    // Best-effort context capacity for selection; force/overflow may still
    // proceed with a minimal recent tail when the adapter exposes no capacity.
    const context = (await this.ctx.llm.resolveModelInfo(route.provider, route.model)).context
    if (context === undefined) {
      if (force) return selectOverflowRange(agent.session, measurement, this.config)
      return null
    }
    const spec = resolveCompactSpec(this.config, context.contextWindow)
    return selectReasonixRange(agent.session, measurement, this.config, spec, this.ctx.tokenMeter, force)
  }

  private _rangeFromSeqs(agent: Agent, start: number, end: number) {
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    const nodes = measurement.nodes
    const startIdx = nodes.findIndex((n) => n.seq === start)
    const endIdx = nodes.findIndex((n) => n.seq === end)
    if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`)
    if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`)
    if (startIdx > endIdx) throw new Error(`compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`)
    if (!toolPairingBalancedBefore(agent.session, nodes[startIdx]!.seq)) throw new Error(`compactRegion: start seq ${start} is not a balanced boundary`)
    if (!toolPairingBalancedAfter(agent.session, nodes[endIdx]!.seq)) throw new Error(`compactRegion: end seq ${end} is not a balanced boundary`)
    const shadowed = nodes.slice(startIdx, endIdx + 1)
    return {
      start,
      end,
      startIdx,
      endIdx,
      shadowedSeqs: shadowed.map((n) => n.seq),
      shadowedTokenCount: shadowed.reduce((sum, n) => sum + n.tokens, 0),
    }
  }

  private async _compactSurfaceRegion(
    agent: Agent,
    range: { start: number; end: number; startIdx: number; endIdx: number; shadowedSeqs: number[]; shadowedTokenCount: number },
    options: CompactionTransactionOptions,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const session = agent.session
    if (options.owner === null) signal?.throwIfAborted()
    const entryState = inspectCompactionEntryState(session.events)
    assertCompactionInactive(entryState.unmatchedCompactionStart, entryState.latestEndSeedSeq, 'compaction')

    let owner: number | null
    if (options.owner === null) {
      if (entryState.openTurn !== null) throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn')
      owner = null
    } else {
      if (entryState.openTurn === null) throw new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn')
      owner = entryState.openTurn
    }

    const compactionId = CompactionId(randomUUID())
    const lifecycle = {
      compactionId,
      ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
      turn: owner,
    }
    const startEvent = session.append('compaction/start', lifecycle)
    const assertStable = options.stability === 'whole-surface' ? this._assertWholeSurfaceUnchanged.bind(this) : this._assertSelectedSpanStable.bind(this)

    let failure: { error: unknown; stage: string } | undefined
    let flushFailure: unknown
    let result: CompactionResult | undefined
    let closed = false
    let closing = false
    let stage = 'summary'

    try {
      const measurement = this.ctx.tokenMeter.measure(session)
      const selectedNodes = measurement.nodes.slice(range.startIdx, range.endIdx + 1)
      if (selectedNodes.length !== range.shadowedSeqs.length || selectedNodes.some((node, index) => node.seq !== range.shadowedSeqs[index])) {
        throw new SurfaceChangedError('compaction: selected surface changed before summarization began')
      }
      const input = buildSummarizationInput(session, range.shadowedSeqs)
      const summaryResult = await this.summarize(input, agent, signal)
      if (options.owner === null) signal?.throwIfAborted()
      assertStable(session, range, measurement)

      const checkpointMessage = createUserMessage({
        content: frameSummary(summaryResult.summary),
        source: compactCheckpointSource(compactionId, options.sourceCommandId),
      })
      const framedSummaryTokenCount = this.ctx.tokenMeter.estimateMessage(checkpointMessage)
      const sourceTokens = measurement.totalTokens
      const candidateTokens = sourceTokens - range.shadowedTokenCount + framedSummaryTokenCount
      const fixedPrefix = fixedPrefixTokens(measurement, range.startIdx)
      // The summarizer may have fallen back to a different provider/model than
      // the conversation's latest routed target. Price and validate the
      // checkpoint against the route that actually produced the summary; using
      // routedTarget() here can re-contact a dead provider and turn a successful
      // fallback into a misleading generic "summary" failure.
      const spec = await this._specFor(agent, signal, {
        provider: summaryResult.provider,
        model: summaryResult.model,
      })
      if (spec !== null) {
        acceptCheckpointCandidate({
          trigger: options.trigger,
          force: options.force,
          sourceTokens,
          candidateTokens,
          fixedPrefixTokens: fixedPrefix,
          spec,
          config: this.config,
        })
      } else if (candidateTokens >= sourceTokens) {
        throw new Error(`checkpoint rejected: candidate would not reduce tokens (${candidateTokens} >= ${sourceTokens})`)
      }

      stage = 'commit'
      const pending = this._commitCompactionBody(session, startEvent, {
        ...range,
        summary: summaryResult.summary,
        provider: summaryResult.provider,
        model: summaryResult.model,
        maxTokens: summaryResult.maxTokens,
        usage: summaryResult.usage,
        rawOutput: summaryResult.rawOutput,
        llmStreamCall: summaryResult.llmStreamCall === true,
        checkpointMessage,
      })
      closing = true
      const endEvent = session.append('compaction/end', lifecycle)
      closed = true
      result = completeCompaction(pending, endEvent)
    } catch (error) {
      failure = { error, stage: closing ? 'commit' : stage }
      if (!closing) {
        closing = true
        try {
          session.append('compaction/end', { ...lifecycle, error: errorChain(error) })
          closed = true
        } catch (closeError) {
          failure = { error: closeError, stage: 'commit' }
        }
      }
    }

    if (closed && options.flush !== undefined) {
      try {
        await options.flush()
      } catch (error) {
        flushFailure = error
      }
    }
    if (options.owner === null) signal?.throwIfAborted()
    if (failure !== undefined) {
      if (options.owner === null) throwManualFailure(failure)
      throw failure.error
    }
    if (flushFailure !== undefined) throw new ManualCompactionError('persistence', 'manual compaction durability checkpoint failed', { cause: flushFailure })
    if (result === undefined) throw new Error('compaction committed without a result')
    return result
  }

  private _commitCompactionBody(
    session: Session,
    startEvent: SessionEvent,
    summarized: {
      start: number
      end: number
      shadowedSeqs: number[]
      shadowedTokenCount: number
      summary: ContentBlock[]
      provider: string
      model: string
      maxTokens?: number
      usage?: TokenUsage
      rawOutput?: ContentBlock[]
      llmStreamCall: boolean
      checkpointMessage: UserMessage
    },
  ) {
    const { start, end, shadowedSeqs, shadowedTokenCount, summary, provider, model, maxTokens, usage, checkpointMessage } = summarized
    const callProvenance = summarized.llmStreamCall
      ? { rawOutput: summarized.rawOutput!, llmStreamCall: true as const }
      : summarized.rawOutput === undefined
        ? {}
        : { rawOutput: summarized.rawOutput }
    const summaryEvent = session.append('compaction/summary', {
      compactionId: (startEvent.data as { compactionId: CompactionId }).compactionId,
      ...((startEvent.data as { sourceCommandId?: CommandId }).sourceCommandId === undefined ? {} : { sourceCommandId: (startEvent.data as { sourceCommandId?: CommandId }).sourceCommandId }),
      summary,
      ...callProvenance,
      shadowedRange: { start, end },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount,
      provider,
      model,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(usage === undefined ? {} : { usage }),
    })
    session.append('user/message', checkpointMessage, {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    })
    return {
      compactionId: (startEvent.data as { compactionId: CompactionId }).compactionId,
      ...((startEvent.data as { sourceCommandId?: CommandId }).sourceCommandId === undefined ? {} : { sourceCommandId: (startEvent.data as { sourceCommandId?: CommandId }).sourceCommandId }),
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      summary,
      shadowedRange: { start, end },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount,
    }
  }

  private _assertWholeSurfaceUnchanged(session: Session, range: { startIdx: number; endIdx: number }, preparedMeasurement: ReturnType<typeof this.ctx.tokenMeter.measure>): void {
    const current = this.ctx.tokenMeter.measure(session)
    if (!isDeepStrictEqual(current.nodes, preparedMeasurement.nodes)) {
      throw new SurfaceChangedError('compaction: session surface changed during summarization')
    }
  }

  private _assertSelectedSpanStable(session: Session, range: { start: number; end: number; shadowedSeqs: number[] }, preparedMeasurement: ReturnType<typeof this.ctx.tokenMeter.measure>): void {
    let current: ReturnType<typeof this.ctx.tokenMeter.measure>
    try {
      current = this.ctx.tokenMeter.measure(session)
      const startIdx = current.nodes.findIndex((n) => n.seq === range.start)
      const endIdx = current.nodes.findIndex((n) => n.seq === range.end)
      if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) throw new Error('span missing')
      const currentSeqs = current.nodes.slice(startIdx, endIdx + 1).map((n) => n.seq)
      if (!isDeepStrictEqual(currentSeqs, range.shadowedSeqs)) throw new Error('span changed')
    } catch (error) {
      throw new SurfaceChangedError('compaction: the selected span is no longer a valid replacement target', { cause: error })
    }
  }

  private async _specFor(
    agent: Agent,
    signal?: AbortSignal,
    preferredTarget?: { provider: string; model: string },
  ): Promise<CacheAwareCompactSpec | null> {
    const target = preferredTarget ?? routedTarget(agent.session) ?? conversationTarget(agent)
    if (target === undefined) return null
    const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context
    if (context === undefined) return null
    return resolveCompactSpec(this.config, context.contextWindow)
  }
}

function completeCompaction(pending: Omit<CompactionResult, 'endSeq'>, endEvent: SessionEvent): CompactionResult {
  return { ...pending, endSeq: endEvent.seq }
}

function throwManualFailure(failure: { error: unknown; stage: string }): never {
  if (failure.stage === 'commit') throw new ManualCompactionError('commit', 'manual compaction did not commit cleanly', { cause: failure.error })
  if (failure.error instanceof SurfaceChangedError) throw new ManualCompactionError('changed', 'the compacted history changed during manual compaction', { cause: failure.error })
  throw new ManualCompactionError('summary', 'manual compaction could not produce a smaller summary', { cause: failure.error })
}
