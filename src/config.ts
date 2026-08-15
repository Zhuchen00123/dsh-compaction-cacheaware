/**
 * Configuration vocabulary for the Reasonix-style cache-aware compaction backend.
 *
 * The original Reasonix design keeps a canonical transcript append-only and
 * installs at most one provider-visible checkpoint when the projected request
 * crosses `compact_ratio × context_window`. This file mirrors the tunable
 * constants from `internal/agent/compact.go` / `compact_projection.go`.
 *
 * @module dsh-compaction-cacheaware/config
 */

import {
  REASONIX_CHECKPOINT_CEILING_RATIO,
  REASONIX_DEFAULT_COMPACT_RATIO,
  REASONIX_EXCEPTIONAL_MIN_SAVINGS_RATIO,
  REASONIX_KEPT_USER_TURNS_BUDGET_TOKENS,
  REASONIX_KEPT_USER_TURNS_WINDOW_FRAC,
  REASONIX_MAX_KEPT_USER_TURN_TOKENS,
  REASONIX_MAX_PINNED_FIRST_USER_TOKENS,
  REASONIX_MAX_RECENT_TAIL_TOKENS,
  REASONIX_MIN_COMPACT_MESSAGES,
  REASONIX_MIN_RECENT_KEEP,
  REASONIX_MIN_RECENT_TAIL_TOKENS,
  REASONIX_PINNED_FIRST_USER_WINDOW_FRAC,
  REASONIX_PROTOCOL_RESERVE_TOKENS,
  REASONIX_RECENT_TAIL_BUDGET_RATIO,
  REASONIX_SUMMARY_OUTPUT_MAX_TOKENS,
} from './generated/reasonix-constants.js'

export interface CacheAwareCompactionConfig {
  /** Sole automatic trigger: compact when projected tokens >= ratio × window. Default 0.85. */
  compactRatio?: number
  /** Normal auto-checkpoint acceptance ceiling. Default 0.50. */
  checkpointCeilingRatio?: number
  /** Recent verbatim tail as a fraction of the window. Default 0.10. */
  recentTailRatio?: number
  /** Lower bound for the recent tail in production windows. Default 32 KiB tokens. */
  recentTailMinTokens?: number
  /** Upper bound for the recent tail. Default 96 KiB tokens. */
  recentTailMaxTokens?: number
  /** Max tokens for the summarizer output. Default 16 KiB. */
  summaryMaxTokens?: number
  /** When the fixed prefix alone exceeds the ceiling, require this fraction savings. Default 0.25. */
  exceptionalMinSavingsRatio?: number
  /** Never keep fewer recent messages than this. Default 2. */
  minRecentKeep?: number
  /** Skip compaction below this many compactable messages. Default 2. */
  minCompactMessages?: number
  /** Ceiling on pinning the first user turn verbatim. Default 1500. */
  maxPinnedFirstUserTokens?: number
  /** And never pin a first turn worth more than this fraction of the window. Default 0.15. */
  pinnedFirstUserWindowFrac?: number
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
  readonly checkpointCeilingRatio: number
  readonly recentTailRatio: number
  readonly recentTailMinTokens: number
  readonly recentTailMaxTokens: number
  readonly summaryMaxTokens: number
  readonly exceptionalMinSavingsRatio: number
  readonly minRecentKeep: number
  readonly minCompactMessages: number
  readonly maxPinnedFirstUserTokens: number
  readonly pinnedFirstUserWindowFrac: number
  readonly protocolReserveTokens: number
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly auto: boolean
}

const DEFAULTS = {
  compactRatio: REASONIX_DEFAULT_COMPACT_RATIO,
  checkpointCeilingRatio: REASONIX_CHECKPOINT_CEILING_RATIO,
  recentTailRatio: REASONIX_RECENT_TAIL_BUDGET_RATIO,
  recentTailMinTokens: REASONIX_MIN_RECENT_TAIL_TOKENS,
  recentTailMaxTokens: REASONIX_MAX_RECENT_TAIL_TOKENS,
  summaryMaxTokens: REASONIX_SUMMARY_OUTPUT_MAX_TOKENS,
  exceptionalMinSavingsRatio: REASONIX_EXCEPTIONAL_MIN_SAVINGS_RATIO,
  minRecentKeep: REASONIX_MIN_RECENT_KEEP,
  minCompactMessages: REASONIX_MIN_COMPACT_MESSAGES,
  maxPinnedFirstUserTokens: REASONIX_MAX_PINNED_FIRST_USER_TOKENS,
  pinnedFirstUserWindowFrac: REASONIX_PINNED_FIRST_USER_WINDOW_FRAC,
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
  const checkpointCeilingRatio = ratio(config.checkpointCeilingRatio, 'checkpointCeilingRatio', DEFAULTS.checkpointCeilingRatio)
  const recentTailRatio = ratio(config.recentTailRatio, 'recentTailRatio', DEFAULTS.recentTailRatio)
  const recentTailMinTokens = positiveInt(config.recentTailMinTokens, 'recentTailMinTokens', DEFAULTS.recentTailMinTokens)
  const recentTailMaxTokens = positiveInt(config.recentTailMaxTokens, 'recentTailMaxTokens', DEFAULTS.recentTailMaxTokens)
  const summaryMaxTokens = positiveInt(config.summaryMaxTokens, 'summaryMaxTokens', DEFAULTS.summaryMaxTokens)
  const exceptionalMinSavingsRatio = ratio(config.exceptionalMinSavingsRatio, 'exceptionalMinSavingsRatio', DEFAULTS.exceptionalMinSavingsRatio)
  const minRecentKeep = positiveInt(config.minRecentKeep, 'minRecentKeep', DEFAULTS.minRecentKeep)
  const minCompactMessages = positiveInt(config.minCompactMessages, 'minCompactMessages', DEFAULTS.minCompactMessages)
  const maxPinnedFirstUserTokens = positiveInt(config.maxPinnedFirstUserTokens, 'maxPinnedFirstUserTokens', DEFAULTS.maxPinnedFirstUserTokens)
  const pinnedFirstUserWindowFrac = ratio(config.pinnedFirstUserWindowFrac, 'pinnedFirstUserWindowFrac', DEFAULTS.pinnedFirstUserWindowFrac)
  const protocolReserveTokens = nonNegativeInt(config.protocolReserveTokens, 'protocolReserveTokens', DEFAULTS.protocolReserveTokens)
  const summarizationProvider = stringField(config.summarizationProvider, 'summarizationProvider', DEFAULTS.summarizationProvider)
  const summarizationModel = stringField(config.summarizationModel, 'summarizationModel', DEFAULTS.summarizationModel)
  const auto = config.auto ?? DEFAULTS.auto
  if (typeof auto !== 'boolean') throw new Error('CacheAwareCompactionConfig: auto must be a boolean')
  if (recentTailMinTokens > recentTailMaxTokens) {
    throw new Error('CacheAwareCompactionConfig: recentTailMinTokens must not exceed recentTailMaxTokens')
  }
  if (checkpointCeilingRatio >= compactRatio) {
    // Reasonix keeps the normal ceiling below the trigger; this is a sanity guard.
    throw new Error('CacheAwareCompactionConfig: checkpointCeilingRatio must be below compactRatio')
  }
  return Object.freeze({
    compactRatio,
    checkpointCeilingRatio,
    recentTailRatio,
    recentTailMinTokens,
    recentTailMaxTokens,
    summaryMaxTokens,
    exceptionalMinSavingsRatio,
    minRecentKeep,
    minCompactMessages,
    maxPinnedFirstUserTokens,
    pinnedFirstUserWindowFrac,
    protocolReserveTokens,
    summarizationProvider,
    summarizationModel,
    auto,
  })
}

/** Concrete token budgets for one model capacity. */
export interface CacheAwareCompactSpec {
  readonly contextWindow: number
  readonly thresholdTokens: number
  readonly ceilingTokens: number
  readonly hardCeilingTokens: number
  readonly recentTailTokens: number
  readonly exceptionalMinSavingsTokens: number
}

/** Resolve token budgets for a routed model's context window. */
export function resolveCompactSpec(config: ResolvedCacheAwareConfig, contextWindow: number): CacheAwareCompactSpec {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new Error(`CacheAwareCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`)
  }
  const recentTailTokens = Math.min(
    config.recentTailMaxTokens,
    Math.max(
      config.recentTailMinTokens,
      Math.floor(contextWindow * config.recentTailRatio),
    ),
  )
  // Small synthetic/test windows should not let the 32K floor exceed the window.
  const maxTail = Math.max(1, Math.floor(contextWindow / 2))
  return Object.freeze({
    contextWindow,
    thresholdTokens: Math.max(1, Math.floor(contextWindow * config.compactRatio)),
    ceilingTokens: Math.max(1, Math.floor(contextWindow * config.checkpointCeilingRatio)),
    hardCeilingTokens: Math.max(1, contextWindow - config.protocolReserveTokens),
    recentTailTokens: Math.min(recentTailTokens, maxTail),
    exceptionalMinSavingsTokens: Math.max(1, Math.floor(contextWindow * config.exceptionalMinSavingsRatio)),
  })
}
