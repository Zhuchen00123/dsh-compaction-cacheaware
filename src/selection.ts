/**
 * Reasonix-style surface range selection for DSH compaction.
 *
 * DSH's surface is a contiguous ordered list of model-visible nodes; unlike
 * Reasonix's projection model it cannot keep arbitrary middle messages inside
 * a replacement. Following upstream at the synced commit, retention is:
 *   - the system head (`system/message` at surface node 0) as the stable
 *     prefix — upstream's `pinnedPrefixLen` keeps only the system message, so
 *     older user turns, failures, and `[[keep]]` markers all enter the summary
 *     prefix now,
 *   - a recent verbatim tail of `window × recent_tail_ratio` (16%),
 *   - never splitting a tool-call/result pair (DSH official boundary helpers).
 *
 * @module dsh-compaction-cacheaware/selection
 */
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { TokenMeasurement, TokenSurfaceNode } from '@deepseek-ai/dsh-token-meter'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
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
  /**
   * Fixed-heuristic price of the shadowed nodes. This is the shadow price the
   * `compaction/summary` event and the result carry, because the meter folds a
   * replacement with that same estimator.
   */
  shadowedTokenCount: number
  /**
   * Route-priced cost of the same nodes. Budgets and the checkpoint acceptance
   * decision compare against the measured request, so they read this price.
   */
  shadowedRouteTokenCount: number
}

function textOfBlocks(blocks: readonly ContentBlock[]): string {
  let out = ''
  for (const block of blocks) {
    if (block.type === 'text') out += block.text
  }
  return out
}

function textOfMessage(message: Message): string {
  return textOfBlocks(message.content)
}

/**
 * Whether a message is a prior compaction digest.
 *
 * Mirrors upstream `isCompactionSummary`: a digest is a user-role message whose
 * content opens with the summary tag.
 */
export function isCompactionSummaryMessage(message: Message): boolean {
  return message.role === 'user' && textOfMessage(message).trimStart().startsWith(SUMMARY_OPEN_TAG)
}

/** Assert the token-meter surface and the live session surface are identical. */
function assertSurfaceMatchesMeasurement(session: Session, nodes: readonly TokenSurfaceNode[]): void {
  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== nodes.length || surfaceNodes.some((seq, index) => seq !== nodes[index]?.seq)) {
    throw new Error('compaction: token-meter surface does not match the current session surface')
  }
}

/**
 * True when a surface node is a tool result (never a legal tail start).
 *
 * A tool result is now a first-class `tool`-role message carried by a
 * `tool/result` event, not a block embedded in a user message, so the event type
 * is the whole test.
 */
function isToolResultNode(session: Session, seq: number): boolean {
  const event = session.eventAt(SessionSeq(seq))
  if (!event || event.seq !== seq) return false
  return event.type === 'tool/result'
}

/**
 * Index of the first surface node that may be folded (stable prefix end).
 *
 * Upstream `pinnedPrefixLen` keeps only the system message, so the analogue is
 * `messages[0].role === 'system'` — the system prompt is derived history in the
 * current session format (surface node 0). Everything after it, including the
 * first user turn, is foldable.
 */
function pinnedPrefixEnd(messages: readonly Message[], nodes: readonly TokenSurfaceNode[]): number {
  const head = messages.length > 0 && messages[0]!.role === 'system' ? 1 : 0
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
  assertSurfaceMatchesMeasurement(session, nodes)
  if (nodes.length === 0 || messages.length === 0) return null

  const head = pinnedPrefixEnd(messages, nodes)
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
  // Defensive: even if the balance helper disagrees, never start the tail on a
  // tool result whose tool-call would be shadowed.
  while (startIdx > head && startIdx < nodes.length && isToolResultNode(session, nodes[startIdx]!.seq)) {
    startIdx--
  }

  // Re-align after boundary moves (a tool result must not orphan at the tail start).
  while (startIdx > head && startIdx < nodes.length && isToolResultNode(session, nodes[startIdx]!.seq)) {
    startIdx--
  }
  // After alignment startIdx may equal head; re-check minimum compactable span.
  if (startIdx - head < config.minCompactMessages) return null
  if (startIdx < nodes.length && !toolPairingBalancedBefore(session, nodes[startIdx]!.seq)) {
    throw new Error('compaction: tail start is not tool-pairing balanced')
  }

  const endIdx = startIdx - 1
  const shadowed = nodes.slice(head, startIdx)
  return {
    start: shadowed[0]!.seq,
    end: shadowed[shadowed.length - 1]!.seq,
    startIdx: head,
    endIdx,
    shadowedSeqs: shadowed.map((n) => n.seq),
    shadowedTokenCount: shadowed.reduce((sum, n) => sum + n.heuristicTokens, 0),
    shadowedRouteTokenCount: shadowed.reduce((sum, n) => sum + n.tokens, 0),
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
  assertSurfaceMatchesMeasurement(session, nodes)
  if (nodes.length === 0 || messages.length === 0) return null
  const head = 0
  let startIdx = Math.max(head, nodes.length - config.minRecentKeep)
  while (startIdx > head && startIdx < nodes.length && !toolPairingBalancedBefore(session, nodes[startIdx]!.seq)) {
    startIdx--
  }
  // Defensive: never start the tail on a tool result.
  while (startIdx > head && startIdx < nodes.length && isToolResultNode(session, nodes[startIdx]!.seq)) {
    startIdx--
  }
  // Re-align after boundary moves.
  while (startIdx > head && startIdx < nodes.length && isToolResultNode(session, nodes[startIdx]!.seq)) {
    startIdx--
  }
  if (startIdx - head < config.minCompactMessages) return null
  if (startIdx < nodes.length && !toolPairingBalancedBefore(session, nodes[startIdx]!.seq)) {
    throw new Error('compaction: tail start is not tool-pairing balanced')
  }
  const shadowed = nodes.slice(head, startIdx)
  return {
    start: shadowed[0]!.seq,
    end: shadowed[shadowed.length - 1]!.seq,
    startIdx: head,
    endIdx: startIdx - 1,
    shadowedSeqs: shadowed.map((n) => n.seq),
    shadowedTokenCount: shadowed.reduce((sum, n) => sum + n.heuristicTokens, 0),
    shadowedRouteTokenCount: shadowed.reduce((sum, n) => sum + n.tokens, 0),
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
 * Reasonix `acceptCheckpointCandidate` at the synced upstream commit.
 *
 * Upstream requires real savings and, for automatic maintenance, a result below
 * the physical input ceiling (`window - outputTokens - protocolReserveTokens`). The former
 * normal-path 50% checkpoint ceiling, the trigger comparison, and the
 * exceptional fixed-prefix savings path no longer exist upstream: any strictly
 * smaller candidate is accepted, and a manual checkpoint may land above the
 * physical ceiling because it is an explicit rescue.
 */
export function acceptCheckpointCandidate(opts: {
  trigger: string
  sourceTokens: number
  candidateTokens: number
  spec: CacheAwareCompactSpec
}): void {
  const { trigger, sourceTokens, candidateTokens, spec } = opts
  if (candidateTokens >= sourceTokens) {
    throw new Error(`checkpoint rejected: candidate would not reduce tokens (${candidateTokens} >= ${sourceTokens})`)
  }
  if (trigger !== 'manual' && spec.hardCeilingTokens > 0 && candidateTokens >= spec.hardCeilingTokens) {
    throw new Error(`checkpoint rejected: candidate ${candidateTokens} still at or above physical ceiling ${spec.hardCeilingTokens}`)
  }
}
