/**
 * Configuration vocabulary for the Reasonix-style cache-aware compaction backend.
 *
 * Mirrors the tunable constants of upstream `internal/agent/compact.go`
 * (`esengine/DeepSeek-Reasonix`), synced at the commit recorded in
 * `generated/reasonix-constants.ts`.
 *
 * Upstream's maintenance geometry is deliberately small: one trigger ratio, one
 * recent-tail ratio, one summary output budget, and a physical input ceiling
 * derived from the provider protocol reserve. The former checkpoint ceiling,
 * pinned-first-user turn, kept-user-turn, and exceptional-savings knobs no
 * longer exist upstream — `compact_user_turns.go` was deleted and the whole
 * geometry layer collapsed — so they are removed here rather than kept as dead
 * configuration that silently stops tracking anything.
 *
 * @module dsh-compaction-cacheaware/config
 */

import {
  REASONIX_DEFAULT_COMPACT_RATIO,
  REASONIX_MIN_COMPACT_MESSAGES,
  REASONIX_MIN_RECENT_KEEP,
  REASONIX_PROTOCOL_RESERVE_TOKENS,
  REASONIX_RECENT_TAIL_BUDGET_RATIO,
  REASONIX_SUMMARY_OUTPUT_MAX_TOKENS,
} from './generated/reasonix-constants.js'

export interface CacheAwareCompactionConfig {
  /** Automatic ratio trigger, capped by output-adjusted input capacity. Default 0.8. */
  compactRatio?: number
  /** Recent verbatim tail as a fraction of window minus reserved output. Default 0.16. */
  recentTailRatio?: number
  /** Max tokens for the summarizer output. Default 8192. */
  summaryMaxTokens?: number
  /** Never keep fewer recent messages than this. Default 2. */
  minRecentKeep?: number
  /** Skip compaction below this many compactable messages. Default 2. */
  minCompactMessages?: number
  /** Provider framing/control reserve not represented by message estimates. Default 256. */
  protocolReserveTokens?: number
  /** Summary provider; defaults to the latest routed conversation target. */
  summarizationProvider?: string
  /** Summary model; defaults to the latest routed conversation target. */
  summarizationModel?: string
  /** Register automatic pressure/overflow listeners. Default true. */
  auto?: boolean
}

export interface ResolvedCacheAwareConfig {
  readonly compactRatio: number
  readonly recentTailRatio: number
  readonly summaryMaxTokens: number
  readonly minRecentKeep: number
  readonly minCompactMessages: number
  readonly protocolReserveTokens: number
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly auto: boolean
}

const DEFAULTS = {
  compactRatio: REASONIX_DEFAULT_COMPACT_RATIO,
  recentTailRatio: REASONIX_RECENT_TAIL_BUDGET_RATIO,
  summaryMaxTokens: REASONIX_SUMMARY_OUTPUT_MAX_TOKENS,
  minRecentKeep: REASONIX_MIN_RECENT_KEEP,
  minCompactMessages: REASONIX_MIN_COMPACT_MESSAGES,
  protocolReserveTokens: REASONIX_PROTOCOL_RESERVE_TOKENS,
  summarizationProvider: '',
  summarizationModel: '',
  auto: true,
} as const

function finiteNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`CacheAwareCompactionConfig: ${name} must be a finite number`)
  }
  return value
}

function ratio(value: unknown, name: string, fallback: number): number {
  const n = finiteNumber(value, name) ?? fallback
  if (n <= 0 || n >= 1) throw new Error(`CacheAwareCompactionConfig: ${name} must be in (0, 1)`)
  return n
}

function positiveInt(value: unknown, name: string, fallback: number): number {
  const n = finiteNumber(value, name) ?? fallback
  if (!Number.isInteger(n) || n <= 0) throw new Error(`CacheAwareCompactionConfig: ${name} must be a positive integer`)
  return n
}

function nonNegativeInt(value: unknown, name: string, fallback: number): number {
  const n = finiteNumber(value, name) ?? fallback
  if (!Number.isInteger(n) || n < 0) throw new Error(`CacheAwareCompactionConfig: ${name} must be a non-negative integer`)
  return n
}

function stringField(value: unknown, name: string, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new Error(`CacheAwareCompactionConfig: ${name} must be a string`)
  return value
}

/** Validate and detach user config into an immutable resolved config. */
export function resolveConfig(config: CacheAwareCompactionConfig = {}): ResolvedCacheAwareConfig {
  const compactRatio = ratio(config.compactRatio, 'compactRatio', DEFAULTS.compactRatio)
  const recentTailRatio = ratio(config.recentTailRatio, 'recentTailRatio', DEFAULTS.recentTailRatio)
  const summaryMaxTokens = positiveInt(config.summaryMaxTokens, 'summaryMaxTokens', DEFAULTS.summaryMaxTokens)
  const minRecentKeep = positiveInt(config.minRecentKeep, 'minRecentKeep', DEFAULTS.minRecentKeep)
  const minCompactMessages = positiveInt(config.minCompactMessages, 'minCompactMessages', DEFAULTS.minCompactMessages)
  const protocolReserveTokens = nonNegativeInt(config.protocolReserveTokens, 'protocolReserveTokens', DEFAULTS.protocolReserveTokens)
  const summarizationProvider = stringField(config.summarizationProvider, 'summarizationProvider', DEFAULTS.summarizationProvider)
  const summarizationModel = stringField(config.summarizationModel, 'summarizationModel', DEFAULTS.summarizationModel)
  const auto = config.auto ?? DEFAULTS.auto
  if (typeof auto !== 'boolean') throw new Error('CacheAwareCompactionConfig: auto must be a boolean')
  if (protocolReserveTokens === 0) {
    // A zero reserve makes the physical ceiling equal the window, so no
    // automatic candidate could ever be accepted.
    throw new Error('CacheAwareCompactionConfig: protocolReserveTokens must be positive so the physical input ceiling stays below the window')
  }
  return Object.freeze({
    compactRatio,
    recentTailRatio,
    summaryMaxTokens,
    minRecentKeep,
    minCompactMessages,
    protocolReserveTokens,
    summarizationProvider,
    summarizationModel,
    auto,
  })
}

/** Concrete token budgets for one model capacity. */
export interface CacheAwareCompactSpec {
  readonly contextWindow: number
  /** Automatic trigger: `min(compactRatio × window, hardCeilingTokens)`. */
  readonly thresholdTokens: number
  /** Physical input-safety boundary: `window - outputTokens - protocolReserveTokens`. */
  readonly hardCeilingTokens: number
  /** Content-construction budget for the recent verbatim tail. */
  readonly recentTailTokens: number
}

/** Resolve budgets with the routed model's requested output reserved outside its input. */
export function resolveCompactSpec(config: ResolvedCacheAwareConfig, contextWindow: number, outputTokens = 0): CacheAwareCompactSpec {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new Error(`CacheAwareCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`)
  }
  if (!Number.isInteger(outputTokens) || outputTokens < 0 || outputTokens >= contextWindow) {
    throw new Error(`CacheAwareCompactionConfig: outputTokens (${outputTokens}) must be a non-negative integer below the context window`)
  }
  const inputBudget = contextWindow - outputTokens
  const hardCeilingTokens = inputBudget - config.protocolReserveTokens
  if (hardCeilingTokens <= 0) {
    throw new Error(`CacheAwareCompactionConfig: outputTokens (${outputTokens}) and protocolReserveTokens (${config.protocolReserveTokens}) leave no input budget in contextWindow (${contextWindow})`)
  }
  const recentTailTokens = Math.max(1, Math.floor(inputBudget * config.recentTailRatio))
  // Preserve Reasonix's half-window guard, applied to the usable input budget.
  const maxTail = Math.max(1, Math.floor(inputBudget / 2))
  return Object.freeze({
    contextWindow,
    thresholdTokens: Math.max(1, Math.min(Math.floor(contextWindow * config.compactRatio), hardCeilingTokens)),
    hardCeilingTokens,
    recentTailTokens: Math.min(recentTailTokens, maxTail),
  })
}
