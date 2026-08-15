/**
 * Reasonix-style summarization directive and checkpoint framing.
 *
 * The directive is delivered as the FINAL user message after the replayed
 * conversation prefix (system + tools + shadowed messages), preserving DSH's
 * warm prefix-cache reuse while asking for Reasonix's exact structured digest.
 *
 * @module dsh-compaction-cacheaware/prompt
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { REASONIX_SUMMARY_INSTRUCTION } from './generated/reasonix-constants.js';
export { REASONIX_SUMMARY_INSTRUCTION };
export declare const SUMMARY_OPEN_TAG = "<compaction-summary>";
export declare const SUMMARY_CLOSE_TAG = "</compaction-summary>";
/** Wrap raw summary blocks in the durable checkpoint framing. */
export declare function frameSummary(summary: readonly ContentBlock[]): ContentBlock[];
