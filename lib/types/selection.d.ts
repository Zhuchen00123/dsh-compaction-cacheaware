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
    shadowedTokenCount: number;
}
export declare function isCompactionSummaryMessage(message: Message): boolean;
export declare function isProtectedMessage(message: Message): boolean;
/** Estimate message tokens with the meter's fixed estimator. */
export declare function estimateMessageTokens(message: Message, meter: {
    estimateMessage(message: Message): number;
}): number;
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
 * Reasonix `acceptCheckpointCandidate`: normal path requires candidate ≤ 50%
 * and below trigger; force/overflow may exceed the ceiling only when still
 * below trigger; manual below trigger accepts any real savings.
 */
export declare function acceptCheckpointCandidate(opts: {
    trigger: string;
    force: boolean;
    sourceTokens: number;
    candidateTokens: number;
    fixedPrefixTokens: number;
    spec: CacheAwareCompactSpec;
    config: ResolvedCacheAwareConfig;
}): void;
