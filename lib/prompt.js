/**
 * Reasonix-style summarization directive and checkpoint framing.
 *
 * The directive is delivered as the FINAL user message after the replayed
 * conversation prefix (system + tools + shadowed messages), preserving DSH's
 * warm prefix-cache reuse while asking for Reasonix's exact structured digest.
 *
 * @module dsh-compaction-cacheaware/prompt
 */
import { REASONIX_SUMMARY_INSTRUCTION, REASONIX_SUMMARY_TAG_CLOSE, REASONIX_SUMMARY_TAG_OPEN, } from './generated/reasonix-constants.js';
export { REASONIX_SUMMARY_INSTRUCTION };
export const SUMMARY_OPEN_TAG = REASONIX_SUMMARY_TAG_OPEN;
export const SUMMARY_CLOSE_TAG = REASONIX_SUMMARY_TAG_CLOSE;
const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';
/** Wrap raw summary blocks in the durable checkpoint framing. */
export function frameSummary(summary) {
    return [
        { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
        ...summary,
        { type: 'text', text: SUMMARY_CLOSE_TAG },
    ];
}
