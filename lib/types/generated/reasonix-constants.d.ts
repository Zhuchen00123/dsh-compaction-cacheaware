/**
 * AUTO-GENERATED from esengine/DeepSeek-Reasonix.
 * Run `node scripts/sync-reasonix-compact.mjs` to refresh after upstream changes.
 * @module dsh-compaction-cacheaware/generated/reasonix-constants
 */
export declare const REASONIX_UPSTREAM_COMMIT = "352d171b3254c36cb36dd25532d0ef7e6f7d7f0a";
export declare const REASONIX_DEFAULT_COMPACT_RATIO = 0.85;
export declare const REASONIX_CHECKPOINT_CEILING_RATIO = 0.5;
export declare const REASONIX_RECENT_TAIL_BUDGET_RATIO = 0.1;
export declare const REASONIX_MIN_RECENT_TAIL_TOKENS = 8192;
export declare const REASONIX_MAX_RECENT_TAIL_TOKENS = 16384;
export declare const REASONIX_SUMMARY_OUTPUT_MAX_TOKENS = 16384;
export declare const REASONIX_EXCEPTIONAL_MIN_SAVINGS_RATIO = 0.25;
export declare const REASONIX_MIN_RECENT_KEEP = 2;
export declare const REASONIX_MIN_COMPACT_MESSAGES = 2;
export declare const REASONIX_MAX_PINNED_FIRST_USER_TOKENS = 1500;
export declare const REASONIX_PINNED_FIRST_USER_WINDOW_FRAC = 0.15;
export declare const REASONIX_MAX_KEPT_USER_TURN_TOKENS = 1500;
export declare const REASONIX_KEPT_USER_TURNS_BUDGET_TOKENS = 8192;
export declare const REASONIX_KEPT_USER_TURNS_WINDOW_FRAC = 0.05;
export declare const REASONIX_PROTOCOL_RESERVE_TOKENS = 256;
export declare const REASONIX_SUMMARY_TAG_OPEN = "<compaction-summary>";
export declare const REASONIX_SUMMARY_TAG_CLOSE = "</compaction-summary>";
export declare const REASONIX_SUMMARY_INSTRUCTION = "You are compacting the earlier part of a coding agent's conversation to save context.\nThe agent keeps your summary alongside the user's own turns (kept verbatim) and the recent tail; your job is to fold the assistant/tool work into a briefing it can resume from.\nWrite under these exact headings, omitting a heading only if it has no content:\n\n## Standing facts & constraints\nEverything the user stated that still governs the work \u2014 names, paths, IDs, versions, tokens, preferences, and hard \"never do X\" rules \u2014 in their own words. Be exhaustive; this is the durable contract, so prefer over- to under-including.\n\n## Goal\nThe user's request and intent.\n\n## Decisions & rationale\nKey choices made so far and why \u2014 so they are not re-litigated or reversed.\n\n## Files & code\nFiles read or modified, with the specific facts that matter: signatures, line locations, data shapes, and exact edits applied. Be concrete; this is what lets the agent act without re-reading everything.\n\n## Commands & outcomes\nCommands run (builds, tests, git) and their relevant results \u2014 what passed, what failed, and the error text that matters.\n\n## Errors & fixes\nProblems hit and how they were resolved (or not), so the same dead ends are not repeated.\n\n## Pending & next step\nWhat is still in progress or unstarted, and the single most concrete next action to take.\n\nRules: be terse \u2014 bullet points and fragments, not prose. Preserve identifiers, paths, and numbers exactly. Do NOT invent anything not present in the messages; if something is unknown, leave it out rather than guessing.";
