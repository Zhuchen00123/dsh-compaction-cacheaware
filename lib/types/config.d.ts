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
export interface CacheAwareCompactionConfig {
    /** Automatic ratio trigger, capped by output-adjusted input capacity. Default 0.8. */
    compactRatio?: number;
    /** Recent verbatim tail as a fraction of window minus reserved output. Default 0.16. */
    recentTailRatio?: number;
    /** Max tokens for the summarizer output. Default 8192. */
    summaryMaxTokens?: number;
    /** Never keep fewer recent messages than this. Default 2. */
    minRecentKeep?: number;
    /** Skip compaction below this many compactable messages. Default 2. */
    minCompactMessages?: number;
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
    readonly recentTailRatio: number;
    readonly summaryMaxTokens: number;
    readonly minRecentKeep: number;
    readonly minCompactMessages: number;
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
    /** Automatic trigger: `min(compactRatio × window, hardCeilingTokens)`. */
    readonly thresholdTokens: number;
    /** Physical input-safety boundary: `window - outputTokens - protocolReserveTokens`. */
    readonly hardCeilingTokens: number;
    /** Content-construction budget for the recent verbatim tail. */
    readonly recentTailTokens: number;
}
/** Resolve budgets with the routed model's requested output reserved outside its input. */
export declare function resolveCompactSpec(config: ResolvedCacheAwareConfig, contextWindow: number, outputTokens?: number): CacheAwareCompactSpec;
