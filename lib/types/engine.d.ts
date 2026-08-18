/**
 * Reasonix-style cache-aware compaction engine for DSH.
 *
 * Implements the official `@deepseek-ai/dsh-compaction` seam:
 *   - `compactIfNeeded` for automatic pressure and provider-confirmed overflow,
 *   - `compactNow` for manual `/compact`,
 *   - `compactRegion` for programmatic range compaction.
 *
 * The durable transaction mirrors DSH's official `compaction/start → summary →
 * replace → end` bracket while adding Reasonix's checkpoint acceptance checks
 * (≤50% ceiling, below compact_ratio, exceptional fixed-prefix path).
 *
 * @module dsh-compaction-cacheaware/engine
 */
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import { type CacheAwareCompactionConfig, type ResolvedCacheAwareConfig } from './config.js';
export type { CacheAwareCompactionConfig, ResolvedCacheAwareConfig, CacheAwareCompactSpec } from './config.js';
/** Target-specific pressure configuration failure eligible for warning suppression. */
export declare class TargetPressureConfigError extends Error {
    readonly targetKey: string;
    constructor(targetKey: string, message: string);
}
/** Summarizer input: replayed conversation prefix, aligned to the provider cache. */
export interface SummarizationInput {
    readonly system?: string;
    readonly tools?: readonly ToolSchema[];
    readonly messages: readonly Message[];
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
    static Config: z<Schemastery.ObjectS<{
        compactRatio: z<number, number>;
        checkpointCeilingRatio: z<number, number>;
        recentTailRatio: z<number, number>;
        recentTailMinTokens: z<number, number>;
        recentTailMaxTokens: z<number, number>;
        summaryMaxTokens: z<number, number>;
        exceptionalMinSavingsRatio: z<number, number>;
        minRecentKeep: z<number, number>;
        minCompactMessages: z<number, number>;
        maxPinnedFirstUserTokens: z<number, number>;
        pinnedFirstUserWindowFrac: z<number, number>;
        protocolReserveTokens: z<number, number>;
        summarizationProvider: z<string, string>;
        summarizationModel: z<string, string>;
        auto: z<boolean, boolean>;
    }>, Schemastery.ObjectT<{
        compactRatio: z<number, number>;
        checkpointCeilingRatio: z<number, number>;
        recentTailRatio: z<number, number>;
        recentTailMinTokens: z<number, number>;
        recentTailMaxTokens: z<number, number>;
        summaryMaxTokens: z<number, number>;
        exceptionalMinSavingsRatio: z<number, number>;
        minRecentKeep: z<number, number>;
        minCompactMessages: z<number, number>;
        maxPinnedFirstUserTokens: z<number, number>;
        pinnedFirstUserWindowFrac: z<number, number>;
        protocolReserveTokens: z<number, number>;
        summarizationProvider: z<string, string>;
        summarizationModel: z<string, string>;
        auto: z<boolean, boolean>;
    }>>;
    readonly config: ResolvedCacheAwareConfig;
    private readonly overflowRetries;
    private readonly overflowAgents;
    constructor(ctx: Context, config?: CacheAwareCompactionConfig);
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
    private _specFor;
}
