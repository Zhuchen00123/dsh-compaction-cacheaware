/**
 * Reasonix-style surface range selection for DSH compaction.
 *
 * DSH's surface is a contiguous ordered list of model-visible nodes; unlike
 * Reasonix's projection model it cannot keep arbitrary middle messages inside
 * a replacement. We therefore approximate Reasonix's retention by:
 *   - pinning a small first user turn as stable prefix,
 *   - keeping a recent tail with the same `clamp(window×10%, 32K, 96K)` budget,
 *   - moving the cut backward to preserve `[[keep]]` user turns and error tool
 *     results that would otherwise be folded,
 *   - never splitting a tool-call/result pair (DSH official boundary helpers).
 *
 * @module dsh-compaction-cacheaware/selection
 */
import type { Session } from '@deepseek-ai/dsh-session'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { TokenMeasurement, TokenSurfaceNode } from '@deepseek-ai/dsh-token-meter'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { CacheAwareCompactSpec, ResolvedCacheAwareConfig } from './config.js'
import { SUMMARY_OPEN_TAG } from './prompt.js'

export interface SelectedRange {
  /** Inclusive first surface-node seq. */
  start: number
  /** Inclusive last surface-node seq. */
  end: number
  startIdx: number
  endIdx: number
  shadowedSeqs: number[]
  shadowedTokenCount: number
}

function textOfBlocks(blocks: readonly ContentBlock[]): string {
  let out = ''
  for (const block of blocks) {
    if (block.type === 'text') out += block.text
    else if (block.type === 'tool-result') out += textOfBlocks(block.content)
  }
  return out
}

function textOfMessage(message: Message): string {
  return textOfBlocks(message.content)
}

export function isCompactionSummaryMessage(message: Message): boolean {
  return message.role === 'user' && textOfMessage(message).trimStart().startsWith(SUMMARY_OPEN_TAG)
}

export function isProtectedMessage(message: Message): boolean {
  const text = textOfMessage(message).trim().toLowerCase()
  // Tool results in DSH are user-role with a tool-result block; check the
  // structured error flag before text heuristics.
  for (const block of message.content) {
    if (block.type === 'tool-result' && block.isError) return true
  }
  if (message.role === 'user') {
    return text.startsWith('[[keep]]') || text.startsWith('[keep]') || text.startsWith('<keep>') || text.startsWith('<!-- keep -->')
  }
  return text.startsWith('error:') || text.startsWith('blocked:')
}

/** Estimate message tokens with the meter's fixed estimator. */
export function estimateMessageTokens(message: Message, meter: { estimateMessage(message: Message): number }): number {
  return meter.estimateMessage(message)
}

function isUserMessage(message: Message): boolean {
  return message.role === 'user'
}

/** Index of the first surface node that may be folded (stable prefix end). */
function pinnedPrefixEnd(
  messages: readonly Message[],
  nodes: readonly TokenSurfaceNode[],
  config: ResolvedCacheAwareConfig,
  spec: CacheAwareCompactSpec,
  meter: { estimateMessage(message: Message): number },
): number {
  let head = 0
  if (messages.length > 0 && isUserMessage(messages[0]!) && !isCompactionSummaryMessage(messages[0]!)) {
    const cost = estimateMessageTokens(messages[0]!, meter)
    const budget = Math.min(config.maxPinnedFirstUserTokens, Math.floor(spec.contextWindow * config.pinnedFirstUserWindowFrac))
    if (cost <= budget) head = 1
  }
  // Keep index alignment with nodes; nodes and messages are both surface-ordered.
  return Math.min(head, nodes.length)
}

/**
 * Choose the recent-tail start index. Walks newest→oldest, growing the tail
 * until the next node would exceed `tailTokens`, then snaps the cut to a
 * balanced boundary and backs up to protect kept content.
 */
export function selectReasonixRange(
  session: Session,
  measurement: TokenMeasurement,
  config: ResolvedCacheAwareConfig,
  spec: CacheAwareCompactSpec,
  meter: { estimateMessage(message: Message): number },
  force: boolean,
): SelectedRange | null {
  const messages = session.deriveMessages()
  const nodes = measurement.nodes
  if (nodes.length === 0 || messages.length === 0) return null

  const head = pinnedPrefixEnd(messages, nodes, config, spec, meter)
  if (head >= nodes.length) return null

  let tailTokens = spec.recentTailTokens
  if (force) {
    // Reasonix `planCompaction(force=true)` halves the tail for mid-size sessions.
    const half = Math.floor(measurement.surfaceTokens / 2)
    if (half > 0 && half < tailTokens) tailTokens = half
  }

  let startIdx = tailStartIndex(nodes, head, tailTokens, config.minRecentKeep)
  // Align so the tail never begins with an orphan tool result.
  while (startIdx > head && startIdx < nodes.length && !toolPairingBalancedBefore(session, nodes[startIdx]!.seq)) {
    startIdx--
  }

  // Preserve protected messages ([[keep]] user turns, error tool results) by
  // moving the fold boundary before the earliest protected message in the fold.
  for (let i = head; i < startIdx; i++) {
    if (isProtectedMessage(messages[i]!)) {
      startIdx = i
      break
    }
  }
  // After alignment startIdx may equal head; re-check minimum compactable span.
  if (startIdx - head < config.minCompactMessages) return null

  const endIdx = startIdx - 1
  const shadowed = nodes.slice(head, startIdx)
  return {
    start: shadowed[0]!.seq,
    end: shadowed[shadowed.length - 1]!.seq,
    startIdx: head,
    endIdx,
    shadowedSeqs: shadowed.map((n) => n.seq),
    shadowedTokenCount: shadowed.reduce((sum, n) => sum + n.tokens, 0),
  }
}

/** Fallback range for force/overflow when no adapter context capacity is known. */
export function selectOverflowRange(
  session: Session,
  measurement: TokenMeasurement,
  config: ResolvedCacheAwareConfig,
): SelectedRange | null {
  const messages = session.deriveMessages()
  const nodes = measurement.nodes
  if (nodes.length === 0 || messages.length === 0) return null
  const head = 0
  let startIdx = Math.max(head, nodes.length - config.minRecentKeep)
  while (startIdx > head && startIdx < nodes.length && !toolPairingBalancedBefore(session, nodes[startIdx]!.seq)) {
    startIdx--
  }
  for (let i = head; i < startIdx; i++) {
    if (isProtectedMessage(messages[i]!)) {
      startIdx = i
      break
    }
  }
  if (startIdx - head < config.minCompactMessages) return null
  const shadowed = nodes.slice(head, startIdx)
  return {
    start: shadowed[0]!.seq,
    end: shadowed[shadowed.length - 1]!.seq,
    startIdx: head,
    endIdx: startIdx - 1,
    shadowedSeqs: shadowed.map((n) => n.seq),
    shadowedTokenCount: shadowed.reduce((sum, n) => sum + n.tokens, 0),
  }
}

function tailStartIndex(nodes: readonly TokenSurfaceNode[], head: number, budgetTokens: number, minKeep: number): number {
  let start = nodes.length
  let acc = 0
  for (let i = nodes.length - 1; i > head; i--) {
    const cost = nodes[i]!.tokens
    if (nodes.length - i > minKeep && acc + cost > budgetTokens) break
    acc += cost
    start = i
  }
  return Math.max(start, head)
}

/** Compute the fixed-prefix tokens (request envelope + nodes before the range). */
export function fixedPrefixTokens(measurement: TokenMeasurement, startIdx: number): number {
  const headerTokens = Math.max(0, measurement.totalTokens - measurement.surfaceTokens)
  const before = measurement.nodes.slice(0, startIdx).reduce((sum, n) => sum + n.tokens, 0)
  return headerTokens + before
}

/**
 * Reasonix `acceptCheckpointCandidate`: normal path requires candidate ≤ 50%
 * and below trigger; force/overflow may exceed the ceiling only when still
 * below trigger; manual below trigger accepts any real savings.
 */
export function acceptCheckpointCandidate(opts: {
  trigger: string
  force: boolean
  sourceTokens: number
  candidateTokens: number
  fixedPrefixTokens: number
  spec: CacheAwareCompactSpec
  config: ResolvedCacheAwareConfig
}): void {
  const { trigger, force, sourceTokens, candidateTokens, fixedPrefixTokens, spec, config } = opts
  if (candidateTokens >= sourceTokens) {
    throw new Error(`checkpoint rejected: candidate would not reduce tokens (${candidateTokens} >= ${sourceTokens})`)
  }
  const manualBelowTrigger = trigger === 'manual' && sourceTokens < spec.thresholdTokens
  if (manualBelowTrigger) return

  if (fixedPrefixTokens > spec.ceilingTokens) {
    const savings = sourceTokens - candidateTokens
    if (savings < spec.exceptionalMinSavingsTokens) {
      throw new Error(`checkpoint rejected: fixed-prefix exception requires >=${spec.exceptionalMinSavingsTokens} token savings, got ${savings}`)
    }
    if (candidateTokens >= spec.thresholdTokens) {
      throw new Error(`checkpoint rejected: candidate ${candidateTokens} still at or above trigger ${spec.thresholdTokens}`)
    }
    if (candidateTokens >= spec.hardCeilingTokens) {
      throw new Error(`checkpoint rejected: candidate ${candidateTokens} still at or above physical ceiling ${spec.hardCeilingTokens}`)
    }
    return
  }

  if (candidateTokens > spec.ceilingTokens && !force) {
    throw new Error(`checkpoint rejected: candidate ${candidateTokens} exceeds checkpoint ceiling ${spec.ceilingTokens}`)
  }
  if (candidateTokens >= spec.thresholdTokens && !force) {
    throw new Error(`checkpoint rejected: candidate ${candidateTokens} still at or above trigger ${spec.thresholdTokens}`)
  }
  if (force && candidateTokens >= spec.thresholdTokens) {
    throw new Error(`checkpoint rejected: forced candidate ${candidateTokens} still at or above trigger ${spec.thresholdTokens}`)
  }
}
