/**
 * AUTO-GENERATED from esengine/DeepSeek-Reasonix.
 * Run `node scripts/sync-reasonix-compact.mjs` to refresh after upstream changes.
 *
 * Values for constants upstream still exposes come from upstream. Constants listed in
 * REASONIX_UPSTREAM_REMOVED_CONSTANTS no longer exist upstream and hold the last local
 * policy value; retire them from the port. See docs/UPSTREAM_SYNC_REPORT.md.
 * @module dsh-compaction-cacheaware/generated/reasonix-constants
 */
export const REASONIX_UPSTREAM_COMMIT = "2a2dbbeaefe624d1764118d4aafb660fb7a53e0b";
/** Constants the port still consumes that upstream has removed. */
export const REASONIX_UPSTREAM_REMOVED_CONSTANTS = [];
export const REASONIX_DEFAULT_COMPACT_RATIO = 0.8;
export const REASONIX_RECENT_TAIL_BUDGET_RATIO = 0.16;
export const REASONIX_SUMMARY_OUTPUT_MAX_TOKENS = 8192;
export const REASONIX_MIN_RECENT_KEEP = 2;
export const REASONIX_MIN_COMPACT_MESSAGES = 2;
export const REASONIX_PROTOCOL_RESERVE_TOKENS = 256;
export const REASONIX_SUMMARY_TAG_OPEN = "<compaction-summary>";
export const REASONIX_SUMMARY_TAG_CLOSE = "</compaction-summary>";
export const REASONIX_SUMMARY_INSTRUCTION = "Compact the preceding conversation prefix into a durable resume briefing.\nWrite under these exact headings, omitting a heading only if it has no content:\n\n## Standing facts & constraints\nEverything the user stated that still governs the work — names, paths, IDs, versions, tokens, preferences, and hard \"never do X\" rules — in their own words. Be exhaustive; this is the durable contract, so prefer over- to under-including.\n\n## Goal\nThe user's request and intent.\n\n## Decisions & rationale\nKey choices made so far and why — so they are not re-litigated or reversed.\n\n## Files & code\nFiles read or modified, with the specific facts that matter: signatures, line locations, data shapes, and exact edits applied. Be concrete; this is what lets the agent act without re-reading everything.\n\n## Commands & outcomes\nCommands run (builds, tests, git) and their relevant results — what passed, what failed, and the error text that matters.\n\n## Errors & fixes\nProblems hit and how they were resolved (or not), so the same dead ends are not repeated.\n\n## Pending & next step\nWhat is still in progress or unstarted, and the single most concrete next action to take.\n\nRules: be terse — bullet points and fragments, not prose. Preserve identifiers, paths, and numbers exactly. Merge valid facts from any existing <compaction-summary> and remove facts superseded by later messages. Do NOT invent anything not present in the messages; if something is unknown, leave it out rather than guessing. Output only the structured Markdown briefing. Do not call tools. Do not output reasoning.";
