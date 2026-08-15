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
import { REASONIX_CHECKPOINT_CEILING_RATIO, REASONIX_DEFAULT_COMPACT_RATIO, REASONIX_EXCEPTIONAL_MIN_SAVINGS_RATIO, REASONIX_MAX_PINNED_FIRST_USER_TOKENS, REASONIX_MAX_RECENT_TAIL_TOKENS, REASONIX_MIN_COMPACT_MESSAGES, REASONIX_MIN_RECENT_KEEP, REASONIX_MIN_RECENT_TAIL_TOKENS, REASONIX_PINNED_FIRST_USER_WINDOW_FRAC, REASONIX_PROTOCOL_RESERVE_TOKENS, REASONIX_RECENT_TAIL_BUDGET_RATIO, REASONIX_SUMMARY_OUTPUT_MAX_TOKENS, } from './generated/reasonix-constants.js';
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
};
function finiteNumber(value, name) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`CacheAwareCompactionConfig: ${name} must be a finite number`);
    }
    return value;
}
function ratio(value, name, fallback) {
    const n = finiteNumber(value, name) ?? fallback;
    if (n <= 0 || n >= 1)
        throw new Error(`CacheAwareCompactionConfig: ${name} must be in (0, 1)`);
    return n;
}
function positiveInt(value, name, fallback) {
    const n = finiteNumber(value, name) ?? fallback;
    if (!Number.isInteger(n) || n <= 0)
        throw new Error(`CacheAwareCompactionConfig: ${name} must be a positive integer`);
    return n;
}
function nonNegativeInt(value, name, fallback) {
    const n = finiteNumber(value, name) ?? fallback;
    if (!Number.isInteger(n) || n < 0)
        throw new Error(`CacheAwareCompactionConfig: ${name} must be a non-negative integer`);
    return n;
}
function stringField(value, name, fallback) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'string')
        throw new Error(`CacheAwareCompactionConfig: ${name} must be a string`);
    return value;
}
/** Validate and detach user config into an immutable resolved config. */
export function resolveConfig(config = {}) {
    const compactRatio = ratio(config.compactRatio, 'compactRatio', DEFAULTS.compactRatio);
    const checkpointCeilingRatio = ratio(config.checkpointCeilingRatio, 'checkpointCeilingRatio', DEFAULTS.checkpointCeilingRatio);
    const recentTailRatio = ratio(config.recentTailRatio, 'recentTailRatio', DEFAULTS.recentTailRatio);
    const recentTailMinTokens = positiveInt(config.recentTailMinTokens, 'recentTailMinTokens', DEFAULTS.recentTailMinTokens);
    const recentTailMaxTokens = positiveInt(config.recentTailMaxTokens, 'recentTailMaxTokens', DEFAULTS.recentTailMaxTokens);
    const summaryMaxTokens = positiveInt(config.summaryMaxTokens, 'summaryMaxTokens', DEFAULTS.summaryMaxTokens);
    const exceptionalMinSavingsRatio = ratio(config.exceptionalMinSavingsRatio, 'exceptionalMinSavingsRatio', DEFAULTS.exceptionalMinSavingsRatio);
    const minRecentKeep = positiveInt(config.minRecentKeep, 'minRecentKeep', DEFAULTS.minRecentKeep);
    const minCompactMessages = positiveInt(config.minCompactMessages, 'minCompactMessages', DEFAULTS.minCompactMessages);
    const maxPinnedFirstUserTokens = positiveInt(config.maxPinnedFirstUserTokens, 'maxPinnedFirstUserTokens', DEFAULTS.maxPinnedFirstUserTokens);
    const pinnedFirstUserWindowFrac = ratio(config.pinnedFirstUserWindowFrac, 'pinnedFirstUserWindowFrac', DEFAULTS.pinnedFirstUserWindowFrac);
    const protocolReserveTokens = nonNegativeInt(config.protocolReserveTokens, 'protocolReserveTokens', DEFAULTS.protocolReserveTokens);
    const summarizationProvider = stringField(config.summarizationProvider, 'summarizationProvider', DEFAULTS.summarizationProvider);
    const summarizationModel = stringField(config.summarizationModel, 'summarizationModel', DEFAULTS.summarizationModel);
    const auto = config.auto ?? DEFAULTS.auto;
    if (typeof auto !== 'boolean')
        throw new Error('CacheAwareCompactionConfig: auto must be a boolean');
    if (recentTailMinTokens > recentTailMaxTokens) {
        throw new Error('CacheAwareCompactionConfig: recentTailMinTokens must not exceed recentTailMaxTokens');
    }
    if (checkpointCeilingRatio >= compactRatio) {
        // Reasonix keeps the normal ceiling below the trigger; this is a sanity guard.
        throw new Error('CacheAwareCompactionConfig: checkpointCeilingRatio must be below compactRatio');
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
    });
}
/** Resolve token budgets for a routed model's context window. */
export function resolveCompactSpec(config, contextWindow) {
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
        throw new Error(`CacheAwareCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`);
    }
    const recentTailTokens = Math.min(config.recentTailMaxTokens, Math.max(config.recentTailMinTokens, Math.floor(contextWindow * config.recentTailRatio)));
    // Small synthetic/test windows should not let the 32K floor exceed the window.
    const maxTail = Math.max(1, Math.floor(contextWindow / 2));
    return Object.freeze({
        contextWindow,
        thresholdTokens: Math.max(1, Math.floor(contextWindow * config.compactRatio)),
        ceilingTokens: Math.max(1, Math.floor(contextWindow * config.checkpointCeilingRatio)),
        hardCeilingTokens: Math.max(1, contextWindow - config.protocolReserveTokens),
        recentTailTokens: Math.min(recentTailTokens, maxTail),
        exceptionalMinSavingsTokens: Math.max(1, Math.floor(contextWindow * config.exceptionalMinSavingsRatio)),
    });
}
