/**
 * dsh-compaction-cacheaware — Reasonix-style cache-aware compaction for DSH.
 *
 * Mount this plugin in a preset/compaction realm in place of
 * `@deepseek-ai/dsh-compaction-basic`. It implements the same `ctx.compaction`
 * seam, so `@deepseek-ai/dsh-command-compact` and automatic `agent/pre-step`
 * pressure/overflow listeners work unchanged.
 *
 * @module dsh-compaction-cacheaware
 */
import { CacheAwareCompactionEngine } from './engine.js'
import type { CacheAwareCompactionConfig } from './config.js'

export { CacheAwareCompactionEngine, TargetPressureConfigError } from './engine.js'
export type { CacheAwareCompactionConfig, ResolvedCacheAwareConfig, CacheAwareCompactSpec } from './config.js'

export const name = 'compaction-cacheaware'

export default CacheAwareCompactionEngine
