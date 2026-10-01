/**
 * Reasonix-style cache-aware compaction engine for DSH.
 *
 * Implements the official `@deepseek-ai/dsh-compaction` seam:
 *   - `compactIfNeeded` for automatic pressure and provider-confirmed overflow,
 *   - `compactNow` for manual `/compact`,
 *   - `compactRegion` for programmatic range compaction.
 *
 * The durable transaction mirrors DSH's official `compaction/start → summary →
 * replace → end` bracket. A checkpoint must strictly reduce estimated tokens;
 * automatic compaction must also land below the physical input ceiling. Manual
 * compaction is an explicit rescue and may remain above that ceiling.
 *
 * @module dsh-compaction-cacheaware/engine
 */
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, RequestMessage, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import { type CacheAwareCompactionConfig, type ResolvedCacheAwareConfig } from './config.js';
export type { CacheAwareCompactionConfig, ResolvedCacheAwareConfig, CacheAwareCompactSpec } from './config.js';
/** Target-specific pressure configuration failure eligible for warning suppression. */
export declare class TargetPressureConfigError extends Error {
    readonly targetKey: string;
    constructor(targetKey: string, message: string);
}
/**
 * Summarizer input: replayed conversation prefix, aligned to the provider cache.
 *
 * There is deliberately no separate `system` field: since the session format
 * made the system prompt derived history (surface node 0, a `system/message`
 * event), the conversation's own request carries it as a leading message. A
 * summarizer request only reuses the provider's KV cache if it is a genuine
 * prefix of that conversation, so the system prompt rides in `messages`.
 *
 * `messages` accepts request-only user inputs as well as durable messages: the
 * compaction directive appended after the replay is a temporary input with no
 * durable session identity or source.
 */
export interface SummarizationInput {
    readonly tools?: readonly ToolSchema[];
    readonly messages: readonly RequestMessage[];
}
/** Safe summary plus the exact auxiliary call envelope. */
export type SummaryResult = {
    summary: ContentBlock[];
    provider: string;
    model: string;
    maxTokens?: number;
    usage?: TokenUsage;
} & ({
    rawOutput: ContentBlock[];
    llmStreamCall: true;
} | {
    rawOutput?: ContentBlock[];
    llmStreamCall?: never;
});
/**
 * The DSH compaction backend plugin. Mount it in a preset/compaction realm in
 * place of `@deepseek-ai/dsh-compaction-basic`.
 */
export declare class CacheAwareCompactionEngine extends CompactionEngine {
    static inject: readonly ["llm", "tokenMeter", "sessions"];
    static Config: z<{
        compactRatio: number;
        recentTailRatio: number;
        summaryMaxTokens: number;
        minRecentKeep: number;
        minCompactMessages: number;
        protocolReserveTokens: number;
        summarizationProvider: string;
        summarizationModel: string;
        auto: boolean;
    }>;
    readonly config: ResolvedCacheAwareConfig;
    private readonly overflowRetries;
    private readonly overflowAgents;
    private supersededReported;
    constructor(ctx: Context, config?: CacheAwareCompactionConfig);
    /**
     * Late-takeover detection: if another engine constructed after us now owns
     * ctx.compaction, our listeners must not race it for automatic compaction.
     * Warns once, then keeps this instance passive.
     */
    private _realmSuperseded;
    private _registerAutomaticCompaction;
    private isInvalidPromptError;
    private sanitizeErrorMessage;
    private isNonCandidateRetryableError;
    private isRetriableSummarizeError;
    private buildSummarizationCandidates;
    private summarizeWithCandidate;
    protected summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>;
    compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null>;
    compactRegion(start: number, end: number, agent: Agent, signal?: AbortSignal): Promise<CompactionResult>;
    compactNow(agent: Agent, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null>;
    private _selectRange;
    private _rangeFromSeqs;
    private _compactSurfaceRegion;
    private _commitCompactionBody;
    private _assertWholeSurfaceUnchanged;
    private _assertSelectedSpanStable;
    /**
     * Resolve the budgets a checkpoint is accepted against, from the conversation
     * route that will send it: the summary fallback's own window and output budget
     * deliberately play no part in that decision.
     *
     * `null` means only that the route's metadata was unavailable, so the caller
     * falls back to the simple reduction check. A budget failure is a real
     * configuration defect and is deliberately not masked here, and cancellation
     * keeps its own abort reason.
     */
    private _specFor;
}
