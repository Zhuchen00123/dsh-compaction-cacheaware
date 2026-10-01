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
import { REASONIX_DEFAULT_COMPACT_RATIO, REASONIX_MIN_COMPACT_MESSAGES, REASONIX_MIN_RECENT_KEEP, REASONIX_PROTOCOL_RESERVE_TOKENS, REASONIX_RECENT_TAIL_BUDGET_RATIO, REASONIX_SUMMARY_OUTPUT_MAX_TOKENS, } from './generated/reasonix-constants.js';
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
    const recentTailRatio = ratio(config.recentTailRatio, 'recentTailRatio', DEFAULTS.recentTailRatio);
    const summaryMaxTokens = positiveInt(config.summaryMaxTokens, 'summaryMaxTokens', DEFAULTS.summaryMaxTokens);
    const minRecentKeep = positiveInt(config.minRecentKeep, 'minRecentKeep', DEFAULTS.minRecentKeep);
    const minCompactMessages = positiveInt(config.minCompactMessages, 'minCompactMessages', DEFAULTS.minCompactMessages);
    const protocolReserveTokens = nonNegativeInt(config.protocolReserveTokens, 'protocolReserveTokens', DEFAULTS.protocolReserveTokens);
    const summarizationProvider = stringField(config.summarizationProvider, 'summarizationProvider', DEFAULTS.summarizationProvider);
    const summarizationModel = stringField(config.summarizationModel, 'summarizationModel', DEFAULTS.summarizationModel);
    const auto = config.auto ?? DEFAULTS.auto;
    if (typeof auto !== 'boolean')
        throw new Error('CacheAwareCompactionConfig: auto must be a boolean');
    if (protocolReserveTokens === 0) {
        // A zero reserve makes the physical ceiling equal the window, so no
        // automatic candidate could ever be accepted.
        throw new Error('CacheAwareCompactionConfig: protocolReserveTokens must be positive so the physical input ceiling stays below the window');
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
    });
}
/** Resolve budgets with the routed model's requested output reserved outside its input. */
export function resolveCompactSpec(config, contextWindow, outputTokens = 0) {
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
        throw new Error(`CacheAwareCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`);
    }
    if (!Number.isInteger(outputTokens) || outputTokens < 0 || outputTokens >= contextWindow) {
        throw new Error(`CacheAwareCompactionConfig: outputTokens (${outputTokens}) must be a non-negative integer below the context window`);
    }
    const inputBudget = contextWindow - outputTokens;
    const hardCeilingTokens = inputBudget - config.protocolReserveTokens;
    if (hardCeilingTokens <= 0) {
        throw new Error(`CacheAwareCompactionConfig: outputTokens (${outputTokens}) and protocolReserveTokens (${config.protocolReserveTokens}) leave no input budget in contextWindow (${contextWindow})`);
    }
    const recentTailTokens = Math.max(1, Math.floor(inputBudget * config.recentTailRatio));
    // Preserve Reasonix's half-window guard, applied to the usable input budget.
    const maxTail = Math.max(1, Math.floor(inputBudget / 2));
    return Object.freeze({
        contextWindow,
        thresholdTokens: Math.max(1, Math.min(Math.floor(contextWindow * config.compactRatio), hardCeilingTokens)),
        hardCeilingTokens,
        recentTailTokens: Math.min(recentTailTokens, maxTail),
    });
}
