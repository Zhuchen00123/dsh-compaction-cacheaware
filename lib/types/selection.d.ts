import type { Session } from '@deepseek-ai/dsh-session';
import type { Message } from '@deepseek-ai/dsh-llm';
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter';
import type { CacheAwareCompactSpec, ResolvedCacheAwareConfig } from './config.js';
export interface SelectedRange {
    /** Inclusive first surface-node seq. */
    start: number;
    /** Inclusive last surface-node seq. */
    end: number;
    startIdx: number;
    endIdx: number;
    shadowedSeqs: number[];
    /**
     * Fixed-heuristic price of the shadowed nodes. This is the shadow price the
     * `compaction/summary` event and the result carry, because the meter folds a
     * replacement with that same estimator.
     */
    shadowedTokenCount: number;
    /**
     * Route-priced cost of the same nodes. Budgets and the checkpoint acceptance
     * decision compare against the measured request, so they read this price.
     */
    shadowedRouteTokenCount: number;
}
/**
 * Whether a message is a prior compaction digest.
 *
 * Mirrors upstream `isCompactionSummary`: a digest is a user-role message whose
 * content opens with the summary tag.
 */
export declare function isCompactionSummaryMessage(message: Message): boolean;
/**
 * Choose the recent-tail start index. Walks newest→oldest, growing the tail
 * until the next node would exceed `tailTokens`, then snaps the cut to a
 * balanced boundary and backs up to protect kept content.
 */
export declare function selectReasonixRange(session: Session, measurement: TokenMeasurement, config: ResolvedCacheAwareConfig, spec: CacheAwareCompactSpec, meter: {
    estimateMessage(message: Message): number;
}, force: boolean): SelectedRange | null;
/** Fallback range for force/overflow when no adapter context capacity is known. */
export declare function selectOverflowRange(session: Session, measurement: TokenMeasurement, config: ResolvedCacheAwareConfig): SelectedRange | null;
/** Compute the fixed-prefix tokens (request envelope + nodes before the range). */
export declare function fixedPrefixTokens(measurement: TokenMeasurement, startIdx: number): number;
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
export declare function acceptCheckpointCandidate(opts: {
    trigger: string;
    sourceTokens: number;
    candidateTokens: number;
    spec: CacheAwareCompactSpec;
}): void;
