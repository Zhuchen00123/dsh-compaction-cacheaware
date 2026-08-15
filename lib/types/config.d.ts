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
export interface CacheAwareCompactionConfig {
    /** Sole automatic trigger: compact when projected tokens >= ratio × window. Default 0.85. */
    compactRatio?: number;
    /** Normal auto-checkpoint acceptance ceiling. Default 0.50. */
    checkpointCeilingRatio?: number;
    /** Recent verbatim tail as a fraction of the window. Default 0.10. */
    recentTailRatio?: number;
    /** Lower bound for the recent tail in production windows. Default 32 KiB tokens. */
    recentTailMinTokens?: number;
    /** Upper bound for the recent tail. Default 96 KiB tokens. */
    recentTailMaxTokens?: number;
    /** Max tokens for the summarizer output. Default 16 KiB. */
    summaryMaxTokens?: number;
    /** When the fixed prefix alone exceeds the ceiling, require this fraction savings. Default 0.25. */
    exceptionalMinSavingsRatio?: number;
    /** Never keep fewer recent messages than this. Default 2. */
    minRecentKeep?: number;
    /** Skip compaction below this many compactable messages. Default 2. */
    minCompactMessages?: number;
    /** Ceiling on pinning the first user turn verbatim. Default 1500. */
    maxPinnedFirstUserTokens?: number;
    /** And never pin a first turn worth more than this fraction of the window. Default 0.15. */
    pinnedFirstUserWindowFrac?: number;
    /** Provider framing/control reserve not represented by message estimates. Default 256. */
    protocolReserveTokens?: number;
    /** Summary provider; defaults to the latest routed conversation target. */
    summarizationProvider?: string;
    /** Summary model; defaults to the latest routed conversation target. */
    summarizationModel?: string;
    /** Register automatic pressure/overflow listeners. Default true. */
    auto?: boolean;
}
export interface ResolvedCacheAwareConfig {
    readonly compactRatio: number;
    readonly checkpointCeilingRatio: number;
    readonly recentTailRatio: number;
    readonly recentTailMinTokens: number;
    readonly recentTailMaxTokens: number;
    readonly summaryMaxTokens: number;
    readonly exceptionalMinSavingsRatio: number;
    readonly minRecentKeep: number;
    readonly minCompactMessages: number;
    readonly maxPinnedFirstUserTokens: number;
    readonly pinnedFirstUserWindowFrac: number;
    readonly protocolReserveTokens: number;
    readonly summarizationProvider: string;
    readonly summarizationModel: string;
    readonly auto: boolean;
}
/** Validate and detach user config into an immutable resolved config. */
export declare function resolveConfig(config?: CacheAwareCompactionConfig): ResolvedCacheAwareConfig;
/** Concrete token budgets for one model capacity. */
export interface CacheAwareCompactSpec {
    readonly contextWindow: number;
    readonly thresholdTokens: number;
    readonly ceilingTokens: number;
    readonly hardCeilingTokens: number;
    readonly recentTailTokens: number;
    readonly exceptionalMinSavingsTokens: number;
}
/** Resolve token budgets for a routed model's context window. */
export declare function resolveCompactSpec(config: ResolvedCacheAwareConfig, contextWindow: number): CacheAwareCompactSpec;
