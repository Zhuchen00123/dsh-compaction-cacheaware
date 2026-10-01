/**
 * Reasonix-style cache-aware compaction engine for DSH.
 *
 * Implements the official `@deepseek-ai/dsh-compaction` seam:
 *   - `compactIfNeeded` for automatic pressure and provider-confirmed overflow,
 *   - `compactNow` for manual `/compact`,
 *   - `compactRegion` for programmatic range compaction.
 *
 * The durable transaction mirrors DSH's official `compaction/start → summary →
 * replace → end` bracket. A checkpoint must strictly reduce estimated tokens;
 * automatic compaction must also land below the physical input ceiling. Manual
 * compaction is an explicit rescue and may remain above that ceiling.
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
import { SessionSeq } from '@deepseek-ai/dsh-session'
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
  projectToolUpdates,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmResolvedModelInfo, Message, RequestMessage, RequestUserInput, TokenUsage, ToolSchema, UserMessage } from '@deepseek-ai/dsh-llm'
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

/**
 * Summarizer input: replayed conversation prefix, aligned to the provider cache.
 *
 * There is deliberately no separate `system` field: since the session format
 * made the system prompt derived history (surface node 0, a `system/message`
 * event), the conversation's own request carries it as a leading message. A
 * summarizer request only reuses the provider's KV cache if it is a genuine
 * prefix of that conversation, so the system prompt rides in `messages`.
 *
 * `messages` accepts request-only user inputs as well as durable messages: the
 * compaction directive appended after the replay is a temporary input with no
 * durable session identity or source.
 */
export interface SummarizationInput {
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly RequestMessage[]
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

/**
 * Output tokens the routed request reserves, which the provider charges to the
 * same window as the prompt. The effective envelope's own cap wins; otherwise
 * the adapter's per-request default, which the adapter materializes when that
 * envelope omits one. No declared cap means no reservation.
 */
function reservedCompletionTokens(agent: Agent, defaultMaxTokens: number | undefined): number {
  return agent.session.requestHeader()?.config.maxTokens ?? defaultMaxTokens ?? 0
}

/**
 * Read the realm's current `ctx.compaction` owner without throwing when no
 * engine is provided yet (the context proxy raises on unknown services).
 */
function readExistingCompactionService(ctx: Context): unknown {
  try {
    const current = (ctx as { compaction?: unknown }).compaction
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) return current
    // Cordis returns traceable service proxies from context property reads.
    // Compare the provided instance, not a fresh proxy wrapper, or this engine
    // would incorrectly stand down every automatic listener immediately.
    const original = (current as Record<PropertyKey, unknown>)[Symbol.for('cordis.original')]
    return original ?? current
  } catch {
    return undefined
  }
}

function describeCompactionEngine(value: unknown): string {
  if (value instanceof CacheAwareCompactionEngine) return 'dsh-compaction-cacheaware'
  const name = (value as { constructor?: { name?: string } })?.constructor?.name
  if (typeof name === 'string' && name.length > 0) return name
  return typeof value
}

/**
 * Inspect open-turn, unmatched-compaction, and latest seed-boundary state.
 *
 * Reads the log through `session.eventAt()` rather than a materialized event
 * array: the session no longer exposes its log as a property, and the official
 * `dsh-compaction-basic` backend walks it the same way.
 */
function inspectCompactionEntryState(session: Session): {
  openTurn: number | null
  unmatchedCompactionStart: SessionEvent | undefined
  latestEndSeedSeq: number | undefined
} {
  let openTurn: number | null = null
  let openTurnStateKnown = false
  let unmatchedCompactionStart: SessionEvent | undefined
  let compactionEntryStateKnown = false
  let latestEndSeedSeq: number | undefined
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) continue
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
  if (message.role !== 'assistant') return message

  // Reasoning blocks and replayState are provider-private response items.
  // Replaying either in a fresh compaction request is not portable: the OpenAI
  // Responses API may reject old encrypted/items when the new request has
  // different reasoning settings (as Console Go does with invalid_prompt).
  // This must run for every assistant message, including text/tool-call-only
  // messages whose durable content no longer exposes a reasoning block but
  // whose source still carries adapter replay metadata.
  return {
    ...message,
    content: message.content.filter((block) => block.type !== 'reasoning'),
    source: message.source.kind === 'model'
      ? { kind: 'model', provider: message.source.provider, model: message.source.model }
      : message.source,
  }
}

/** Durable file reference carried by one `file` content block. */
type FileAttachment = Extract<ContentBlock, { type: 'file' }>['attachment']

/**
 * Text for one content block in the provider-neutral fallback transcript.
 *
 * A tool result is no longer an embedded content block: it is a `tool`-role
 * message, rendered by {@link portableMessageText} with the call identity that
 * pairs it to its tool call. A file reuses the host's own request-time handle —
 * the only representation a provider ever receives for one. Tool-change blocks
 * get one explicit line each instead of a serialized dump: the transcript
 * carries no declarations of its own, so those records are the only channel that
 * keeps a mid-conversation addition or removal visible to the summarizer.
 */
function portableBlockText(block: ContentBlock, fileText: (ref: FileAttachment) => string): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return ''
    case 'image': {
      // An image is explicitly LOSSY here: the transcript is plain text, so the
      // occurrence is reported from its own durable reference — attachment id,
      // display name when it has one, and the offload mark — and no path is ever
      // fabricated. The normal summarization path leaves image projection to the
      // LLM runtime instead of going through this renderer.
      const { attachment } = block
      const named = attachment.name === undefined ? '' : ` ${attachment.name}`
      const offloaded = block.offloaded === true ? ' offloaded' : ''
      return `[image omitted${offloaded}:${named} ${String(attachment.attachmentId)}]`
    }
    case 'tool-call':
      // The call id stays visible so repeated calls to one tool remain
      // correlatable with the tool-role result that answers each of them.
      return `[tool-call ${String(block.id)} ${block.name}] ${block.arguments}`
    case 'file':
      return fileText(block.attachment)
    case 'tool-addition':
      return `[tool-addition ${block.toolName}]`
    case 'tool-removal':
      return `[tool-removal ${block.toolName}]`
    default:
      return ''
  }
}

/**
 * One transcript entry, keeping a tool result's call identity visible. A failed
 * result states its outcome and is rendered even when it carries no text, so the
 * pair never silently disappears.
 */
function portableMessageText(message: RequestMessage, fileText: (ref: FileAttachment) => string): string {
  const body = message.content.map((block) => portableBlockText(block, fileText)).filter(Boolean).join('\n')
  if (message.role === 'tool') {
    const header = `[tool ${String(message.toolCallId)}${message.isError === true ? ' error' : ''}]`
    return body.length === 0 ? header : `${header}\n${body}`
  }
  return body.length === 0 ? '' : `[${message.role}]\n${body}`
}

/**
 * Last-resort input for a route that rejected the provider-neutral replay.
 *
 * The transcript is plain text, so nothing is serialized verbatim: the declared
 * tool set comes from the host's own `projectToolUpdates` projection, files come
 * from the host's request-time handle, and tool changes become explicit lines.
 * Messages keep their original order, so a tool call and the tool result
 * answering it stay adjacent and paired.
 */
function buildPortableSummarizationInput(input: SummarizationInput, fileText: (ref: FileAttachment) => string): SummarizationInput {
  const declared = projectToolUpdates(
    input.messages,
    input.tools === undefined ? undefined : [...input.tools],
    undefined,
  ).tools ?? []
  const sections = [
    ...(declared.length === 0 ? [] : [`[tools]\n${declared.map((tool) => tool.name).join(', ')}`]),
    ...input.messages.map((message) => portableMessageText(message, fileText)).filter(Boolean),
  ]
  return {
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `Conversation transcript (provider-neutral fallback):\n\n${sections.join('\n\n')}` }],
    }],
  }
}

/**
 * The `system/message` holding surface node 0, or `undefined` when another
 * message-producing event starts the surface.
 */
function systemHead(session: Session): SessionEvent | undefined {
  const headSeq = session.surface.nodes[0]
  if (headSeq === undefined) return undefined
  const head = session.eventAt(headSeq)
  return head?.type === 'system/message' ? head : undefined
}

/**
 * Reconstruct the last routed request's cacheable prefix for the shadowed
 * region: the system prompt held by the `system/message` at surface node 0,
 * the header's tool schemas, then the region's own derived messages in surface
 * order. The summarizer appends only the compaction instruction after this, so
 * the call is a genuine prefix of the conversation and reuses the provider's
 * KV cache.
 */
function buildSummarizationInput(session: Session, shadowedSeqs: readonly number[]): SummarizationInput {
  const header = session.requestHeader()
  const head = systemHead(session)
  const systemMessage = head === undefined ? null : session.deriveEventMessage(head)
  const regionMessages = shadowedSeqs
    .map((seq) => session.eventAt(SessionSeq(seq)))
    .map((event) => (event === undefined ? null : session.deriveEventMessage(event)))
    .filter((message): message is Message => message !== null)
    .map(sanitizeSummarizationMessage)
  return {
    ...(header?.tools === undefined ? {} : { tools: [...header.tools] }),
    messages: systemMessage === null ? regionMessages : [systemMessage, ...regionMessages],
  }
}

/**
 * The DSH compaction backend plugin. Mount it in a preset/compaction realm in
 * place of `@deepseek-ai/dsh-compaction-basic`.
 */
export class CacheAwareCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions'] as const

  // Explicitly annotated: the host packages resolve their own schemastery
  // instance, so relying on this schema's inferred type would make declaration
  // emit depend on which physical copy of the package wins resolution.
  static Config: z<{
    compactRatio: number
    recentTailRatio: number
    summaryMaxTokens: number
    minRecentKeep: number
    minCompactMessages: number
    protocolReserveTokens: number
    summarizationProvider: string
    summarizationModel: string
    auto: boolean
  }> = z.object({
    compactRatio: z.number(),
    recentTailRatio: z.number(),
    summaryMaxTokens: z.number(),
    minRecentKeep: z.number(),
    minCompactMessages: z.number(),
    protocolReserveTokens: z.number(),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    auto: z.boolean(),
  })

  readonly config: ResolvedCacheAwareConfig
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  private supersededReported = false

  constructor(ctx: Context, config: CacheAwareCompactionConfig = {}) {
    // Peek before super(): ctx.compaction still belongs to whoever was mounted
    // first, if anyone. A later construction silently takes the seam over.
    const previous = readExistingCompactionService(ctx)
    super(ctx)
    this.config = resolveConfig(config)
    if (previous !== undefined && previous !== this) {
      if (previous instanceof CacheAwareCompactionEngine) {
        // Replacing our own class is the normal hot-reload path, not a misconfig.
        ctx.logger.info(`compaction-cacheaware: superseding a previous cache-aware engine instance in this realm (expected during hot reload)`)
      } else {
        ctx.logger.warn(`compaction-cacheaware: a compaction engine (${describeCompactionEngine(previous)}) is already mounted in this realm; this mount supersedes it for ctx.compaction. If unintentional, disable the other engine in the same realm — a profile-level bundle patch cannot reach an agent preset's isolated compaction realm, and vice versa.`)
      }
    }
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Late-takeover detection: if another engine constructed after us now owns
   * ctx.compaction, our listeners must not race it for automatic compaction.
   * Warns once, then keeps this instance passive.
   */
  private _realmSuperseded(): boolean {
    const current = readExistingCompactionService(this.ctx)
    const superseded = current !== undefined && current !== this
    if (superseded && !this.supersededReported) {
      this.supersededReported = true
      this.ctx.logger.warn(`compaction-cacheaware: ctx.compaction was taken over by ${describeCompactionEngine(current)} in this realm; this instance stops automatic compaction. Check the realm's plugin mounts for duplicate compaction backends.`)
    } else if (!superseded && this.supersededReported) {
      // Ownership returned (e.g. the other fiber was disposed on hot reload):
      // re-arm so a future takeover is reported again.
      this.supersededReported = false
    }
    return superseded
  }

  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(`compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes (seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`)
    }

    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (this._realmSuperseded()) return next()
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error) {
          if (error instanceof TargetPressureConfigError) {
            // Report the affected target, then continue the turn.
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
      if (this._realmSuperseded()) return next()
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

  private isInvalidPromptError(error: unknown): boolean {
    const values = [
      error instanceof Error ? error.message : String(error),
      (error as { code?: unknown })?.code,
      (error as { cause?: { message?: unknown; code?: unknown } })?.cause?.message,
      (error as { cause?: { message?: unknown; code?: unknown } })?.cause?.code,
    ]
    return values.some((value) => typeof value === 'string' && /invalid_prompt|invalid responses api request|unsupported prompt/i.test(value))
  }

  private sanitizeErrorMessage(raw: string): string {
    const trimmed = raw.trim().slice(0, 220)
    if (!trimmed) return 'unknown error'
    const lower = trimmed.toLowerCase()
    // Strip long provider suffixes and normalize whitespace; keep the diagnostic signal.
    if (/\b(api[_-]?key|token|secret|authorization|bearer|password)\b/i.test(trimmed)) return 'authentication error'
    if (/https?:\/\/\S+/i.test(trimmed)) return `${trimmed.replace(/https?:\/\/\S+/g, '[url]').slice(0, 220)}${raw.length > 220 ? '…' : ''}`
    if (trimmed.length > 220) return trimmed.slice(0, 217) + '…'
    // Treat whitespace-normalization as the only other cleanup.
    if (lower !== trimmed) return trimmed.replace(/\s+/g, ' ')
    return trimmed
  }

  private isNonCandidateRetryableError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error)
    if (/checkpoint rejected|summary is not smaller|SurfaceChanged|would not reduce tokens/i.test(msg)) return false
    return true
  }

  private isRetriableSummarizeError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error)
    if (/checkpoint rejected|summary is not smaller|SurfaceChanged|would not reduce tokens/i.test(msg)) return false
    const code = (error as { code?: unknown })?.code ?? (error as { cause?: { code?: unknown } })?.cause?.code
    if (typeof code === 'string' && /proxy_error|QUOTA|BAD_REQUEST|exhausted|unreachable|MAX_TOKENS|UNSUPPORTED_CONTENT|INVALID_REQUEST/i.test(code)) return true
    if (/all upstreams exhausted|unreachable|proxy_error|invalid_prompt|invalid request|unsupported prompt|BAD_REQUEST|QUOTA|ECONN|ETIMEDOUT|ENOTFOUND|exhausted/i.test(msg)) return true
    // LlmError transport failures are retriable; keep logic conservative
    if (error instanceof LlmError) return /proxy_error|exhausted|unreachable|invalid_request/i.test((error as { code?: string }).code ?? '') || /proxy_error|exhausted|unreachable|invalid_prompt/i.test(msg)
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

    const explicitProvider = this.config.summarizationProvider
    const explicitModel = this.config.summarizationModel
    const hasExplicitRoute = typeof explicitProvider === 'string' && explicitProvider.length > 0
      && typeof explicitModel === 'string' && explicitModel.length > 0
    if (hasExplicitRoute) {
      // Explicit user choice is not optional: respect it and never silently
      // invoke unrelated providers after it. Errors remain structured.
      push(explicitProvider, explicitModel)
      return candidates
    }

    const conv = conversationTarget(agent)
    if (conv) push(conv.provider, conv.model)

    // Bounded per-provider fallback: at most one candidate per provider,
    // preserving registration order. Collect more for inspection, then cap
    // actual summary calls at a small bounded retry budget below.
    try {
      const llm = this.ctx.get('llm')!
      const providers = llm.listProviders() as unknown as Array<{ provider?: string; id?: string } | string>
      for (const entry of providers) {
        const providerName = typeof entry === 'string' ? entry : (entry.provider ?? entry.id ?? '')
        if (!providerName) continue
        const convProvider = conv?.provider
        const alreadyTriedProvider = convProvider !== undefined && providerName === convProvider
        if (alreadyTriedProvider) continue
        try {
          const models = (await llm.listModels(providerName)) as unknown as Array<{ id?: string; provider?: string }>
          for (const m of models) {
            const modelId = m.id ?? ''
            if (!modelId) continue
            try {
              const info = await llm.resolveModelInfo(providerName, modelId, signal)
              if (info?.context?.contextWindow) {
                push(providerName, modelId)
                // One candidate per provider keeps fallback fair and bounded.
                break
              }
            } catch {
              // try next model on this route
            }
          }
        } catch {
          // provider discovery failed, continue
        }
        if (candidates.length >= 8) break
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
    // The directive is a temporary request-only user input: it has no durable
    // session identity or source, so it cannot claim a producer it does not have.
    const directive: RequestUserInput = {
      role: 'user',
      content: [{ type: 'text', text: REASONIX_SUMMARY_INSTRUCTION }],
    }
    const messages: RequestMessage[] = [...input.messages, directive]
    const options = {
      provider,
      model,
      messages,
      toolHistory: agent.session.toolHistory(),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens: this.config.summaryMaxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction' as const,
      ...(signal === undefined ? {} : { signal }),
    }
    for await (const chunk of this.ctx.get('llm')!.stream(options)) assembler.push(chunk)
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

    const hasExplicitRoute = typeof this.config.summarizationProvider === 'string' && this.config.summarizationProvider.length > 0
      && typeof this.config.summarizationModel === 'string' && this.config.summarizationModel.length > 0

    const sanitizedAttempts: string[] = []
    const attempts: string[] = []
    let lastError: unknown
    const budgetedCandidates = hasExplicitRoute ? candidates.slice(0, 1) : candidates.slice(0, 4)
    for (const candidate of budgetedCandidates) {
      try {
        return await this.summarizeWithCandidate(candidate.provider, candidate.model, input, agent, signal)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        attempts.push(`${candidate.provider}/${candidate.model}: ${msg}`)
        sanitizedAttempts.push(`${candidate.provider}/${candidate.model}: ${this.sanitizeErrorMessage(msg)}`)
        const code = (error as { code?: unknown })?.code ?? (error as { cause?: { code?: unknown } })?.cause?.code
        if (typeof code === 'string') sanitizedAttempts[sanitizedAttempts.length - 1] += ` (${code})`

        // Cancellation is not a candidate failure: never spend another request
        // — the portable retry below or the next route — on an aborted operation.
        signal?.throwIfAborted()

        // Some OpenAI-compatible gateways reject a valid provider-neutral
        // conversation replay because of assistant/tool item pairing rules.
        // Retry the same route once with a plain-text transcript: this keeps
        // the provider choice neutral while removing every wire-level item.
        // This portable fallback counts within the same candidate budget.
        if (this.isInvalidPromptError(error)) {
          try {
            return await this.summarizeWithCandidate(
              candidate.provider,
              candidate.model,
              buildPortableSummarizationInput(input, (ref) => this.ctx.get('llm')!.fileRequestText(ref)),
              agent,
              signal,
            )
          } catch (portableError) {
            lastError = portableError
            const portableMsg = portableError instanceof Error ? portableError.message : String(portableError)
            attempts.push(`${candidate.provider}/${candidate.model} portable fallback: ${portableMsg}`)
            sanitizedAttempts.push(`${candidate.provider}/${candidate.model} portable fallback: ${this.sanitizeErrorMessage(portableMsg)}`)
            // Checked before either `continue`, so an abort cannot be swallowed
            // into another candidate attempt.
            signal?.throwIfAborted()
            if (!this.isNonCandidateRetryableError(portableError)) continue
            if (!this.isRetriableSummarizeError(portableError)) continue
            continue
          }
        }

        lastError = error
        if (!this.isRetriableSummarizeError(error)) {
          // Compact's UI surface is intentionally small. For non-transient
          // summarization failures still expose the sanitized candidate chain
          // instead of a single generic sentence.
          throw new Error(`summarization failed: ${sanitizedAttempts.join('; ')}`, { cause: error })
        }
        this.ctx.logger.warn(`compact summarize ${candidate.provider}/${candidate.model} failed: ${msg}; trying next candidate`)
        signal?.throwIfAborted()
      }
    }
    if (lastError !== undefined) {
      // Preserve every candidate failure in the durable compaction/end error.
      // The outer message is user-visible and sanitized; the raw chain remains
      // available through cause/attempts for log inspection.
      const sanitized = sanitizedAttempts.join('; ')
      const aggregate = new Error(`all summarization candidates failed: ${sanitized}`, { cause: lastError })
      const code = (lastError as { code?: unknown })?.code
      if (typeof code === 'string') (aggregate as Error & { code?: string }).code = code
      // Avoid exposing full provider payloads at the UI surface; keep the raw chain reachable as cause.
      throw aggregate
    }
    throw new Error('no summarization candidates available after discovery')
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
    const info = await this.ctx.get('llm')!.resolveModelInfo(target.provider, target.model, signal)
    const context = info.context
    const targetKey = `${target.provider}/${target.model}`
    if (context === undefined) {
      throw new TargetPressureConfigError(targetKey, `CacheAwareCompaction: no context capacity for ${targetKey}; configure contextWindow on that adapter model`)
    }
    // The routed request's output reservation shares the window with its prompt,
    // so the input budgets are computed below it.
    const spec = resolveCompactSpec(this.config, context.contextWindow, reservedCompletionTokens(agent, info.defaultMaxTokens))
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
    let maintenanceEntered = false
    try {
      return await agent.runMaintenance(async (agentSignal) => {
        maintenanceEntered = true
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
      // User cancellation is not a busy agent: surface the abort reason instead
      // of classifying it as an unavailable idle session.
      signal.throwIfAborted()
      if (maintenanceEntered) throw error
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
    const info = await this.ctx.get('llm')!.resolveModelInfo(route.provider, route.model)
    const context = info.context
    if (context === undefined) {
      if (force) return selectOverflowRange(agent.session, measurement, this.config)
      return null
    }
    const spec = resolveCompactSpec(this.config, context.contextWindow, reservedCompletionTokens(agent, info.defaultMaxTokens))
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
      shadowedTokenCount: shadowed.reduce((sum, n) => sum + n.heuristicTokens, 0),
      shadowedRouteTokenCount: shadowed.reduce((sum, n) => sum + n.tokens, 0),
    }
  }

  private async _compactSurfaceRegion(
    agent: Agent,
    range: { start: number; end: number; startIdx: number; endIdx: number; shadowedSeqs: number[]; shadowedTokenCount: number; shadowedRouteTokenCount: number },
    options: CompactionTransactionOptions,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const session = agent.session
    if (options.owner === null) signal?.throwIfAborted()
    const entryState = inspectCompactionEntryState(session)
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
      // Selection may await route metadata. Refresh both prices from this
      // transaction's measurement, so acceptance and persisted shadow prices
      // cannot mix the selection snapshot with the prepared snapshot.
      range = {
        ...range,
        shadowedTokenCount: selectedNodes.reduce((sum, node) => sum + node.heuristicTokens, 0),
        shadowedRouteTokenCount: selectedNodes.reduce((sum, node) => sum + node.tokens, 0),
      }
      // Snapshot the CONVERSATION route's budgets before summarizing. The
      // checkpoint replaces conversation history and is accepted on the
      // conversation meter's terms, so a summarizer fallback onto a smaller
      // window must not veto it — and re-resolving the original route afterwards
      // could contact a provider that just failed.
      const spec = await this._specFor(agent, signal)
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
      // Budgets and the acceptance decision compare against the measured
      // request, so the replaced range is priced on the same route-priced scale.
      // The persisted shadow price below stays heuristic: the meter folds a
      // replacement with the fixed estimator, not with a route price.
      const candidateTokens = sourceTokens - range.shadowedRouteTokenCount + framedSummaryTokenCount
      const fixedPrefix = fixedPrefixTokens(measurement, range.startIdx)
      if (spec !== null) {
        // Upstream rejects a fold whose fixed prefix alone already crosses the
        // trigger: no checkpoint can bring such a request back under it. Mirrors
        // compact_projection.go.
        if (fixedPrefix >= spec.thresholdTokens) {
          throw new Error(`checkpoint rejected: fixed prefix (${fixedPrefix} tokens) already exceeds trigger (${spec.thresholdTokens})`)
        }
        acceptCheckpointCandidate({
          trigger: options.trigger,
          sourceTokens,
          candidateTokens,
          spec,
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
      shadowedRange: { start: SessionSeq(start), end: SessionSeq(end) },
      shadowedSeqs: shadowedSeqs.map((seq) => SessionSeq(seq)),
      shadowedTokenCount,
      provider,
      model,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(usage === undefined ? {} : { usage }),
    })
    session.append('user/message', checkpointMessage, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(start), endSeq: SessionSeq(end) },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs.map((seq) => SessionSeq(seq))],
    })
    return {
      compactionId: (startEvent.data as { compactionId: CompactionId }).compactionId,
      ...((startEvent.data as { sourceCommandId?: CommandId }).sourceCommandId === undefined ? {} : { sourceCommandId: (startEvent.data as { sourceCommandId?: CommandId }).sourceCommandId }),
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      summary,
      shadowedRange: { start: SessionSeq(start), end: SessionSeq(end) },
      shadowedSeqs: shadowedSeqs.map((seq) => SessionSeq(seq)),
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
    let startIdx: number
    let endIdx: number
    try {
      current = this.ctx.tokenMeter.measure(session)
      startIdx = current.nodes.findIndex((n) => n.seq === range.start)
      endIdx = current.nodes.findIndex((n) => n.seq === range.end)
      if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) throw new Error('span missing')
      // Both edges must still be balanced, or the replacement could split a
      // tool-call/result pair (official `validateSurfaceRegion`).
      if (!toolPairingBalancedBefore(session, SessionSeq(range.start))) throw new Error('span start is not a balanced boundary')
      if (!toolPairingBalancedAfter(session, SessionSeq(range.end))) throw new Error('span end is not a balanced boundary')
    } catch (error) {
      throw new SurfaceChangedError('compaction: the selected span is no longer a valid replacement target', { cause: error })
    }
    const currentSpan = current.nodes.slice(startIdx, endIdx + 1)
    if (!isDeepStrictEqual(currentSpan.map((node) => node.seq), range.shadowedSeqs)) {
      throw new SurfaceChangedError('compaction: the selected span changed during summarization')
    }
    // The span must still be priced exactly as it was when the summary started.
    // Comparing seqs alone would accept a same-seq repricing — an image offload
    // or tool-result prune that rewrites a selected node — and then price the
    // checkpoint against stale numbers. Appends outside the span stay legal.
    const preparedStartIdx = preparedMeasurement.nodes.findIndex((n) => n.seq === range.start)
    const preparedEndIdx = preparedMeasurement.nodes.findIndex((n) => n.seq === range.end)
    if (preparedStartIdx === -1 || preparedEndIdx === -1
      || !isDeepStrictEqual(currentSpan, preparedMeasurement.nodes.slice(preparedStartIdx, preparedEndIdx + 1))) {
      throw new SurfaceChangedError('compaction: the selected span was rewritten during summarization')
    }
  }

  /**
   * Resolve the budgets a checkpoint is accepted against, from the conversation
   * route that will send it: the summary fallback's own window and output budget
   * deliberately play no part in that decision.
   *
   * `null` means only that the route's metadata was unavailable, so the caller
   * falls back to the simple reduction check. A budget failure is a real
   * configuration defect and is deliberately not masked here, and cancellation
   * keeps its own abort reason.
   */
  private async _specFor(agent: Agent, signal?: AbortSignal): Promise<CacheAwareCompactSpec | null> {
    const target = routedTarget(agent.session) ?? conversationTarget(agent)
    if (target === undefined) return null
    let info: LlmResolvedModelInfo
    try {
      info = await this.ctx.get('llm')!.resolveModelInfo(target.provider, target.model, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      return null
    }
    if (info.context === undefined) return null
    return resolveCompactSpec(this.config, info.context.contextWindow, reservedCompletionTokens(agent, info.defaultMaxTokens))
  }
}

function completeCompaction(pending: Omit<CompactionResult, 'endSeq'>, endEvent: SessionEvent): CompactionResult {
  return { ...pending, endSeq: endEvent.seq }
}

function throwManualFailure(failure: { error: unknown; stage: string }): never {
  if (failure.stage === 'commit') throw new ManualCompactionError('commit', 'manual compaction did not commit cleanly', { cause: failure.error })
  if (failure.error instanceof SurfaceChangedError) throw new ManualCompactionError('changed', 'the compacted history changed during manual compaction', { cause: failure.error })
  // Preserve the structured candidate chain at the manual surface so users
  // see provider/model/code information instead of only a generic sentence.
  if (failure.error instanceof Error && /all summarization candidates failed|summarization failed:|no summarization candidates available|no provider\/model available/i.test(failure.error.message)) {
    throw new ManualCompactionError('summary', failure.error.message, { cause: failure.error })
  }
  throw new ManualCompactionError('summary', 'manual compaction could not produce a smaller summary', { cause: failure.error })
}
