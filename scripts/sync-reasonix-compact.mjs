#!/usr/bin/env node
/**
 * Sync Reasonix compact design into dsh-compaction-cacheaware.
 *
 * This script:
 *   1. Fetches the latest `main-v2` from esengine/DeepSeek-Reasonix.
 *   2. Vendors the upstream compact implementation into `vendor/reasonix/compact/`.
 *   3. Regenerates `src/generated/reasonix-constants.ts` from the Go constants
 *      and summary prompt in `internal/agent/compact.go`.
 *
 * Run locally:  node scripts/sync-reasonix-compact.mjs
 * In CI: the GitHub Action `.github/workflows/sync-reasonix-compact.yml` runs it
 * and opens a PR when files change.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const upstreamUrl = 'https://github.com/esengine/DeepSeek-Reasonix.git'
const upstreamBranch = 'main-v2'
const upstreamDir = join(root, '.tmp', 'reasonix-upstream')
const vendorDir = join(root, 'vendor', 'reasonix', 'compact')
const generatedFile = join(root, 'src', 'generated', 'reasonix-constants.ts')

const compactFiles = [
  'internal/agent/compact.go',
  'internal/agent/compact_fold_input.go',
  'internal/agent/compact_projection.go',
  'internal/agent/compact_commit.go',
  'internal/agent/compact_user_turns.go',
  'internal/agent/context_manager.go',
  'internal/agent/context_usage.go',
  'internal/agent/context_report.go',
  'internal/agent/context_receipt.go',
  'internal/agent/context_recovery.go',
  'internal/agent/context_status.go',
  'docs/research/cache-aware-compaction-design.md',
  'docs/SPEC.md',
]

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
}

function fetchUpstream() {
  if (existsSync(upstreamDir)) {
    run('git', ['-C', upstreamDir, 'fetch', 'origin', upstreamBranch], { stdio: ['ignore', 'pipe', 'pipe'] })
    run('git', ['-C', upstreamDir, 'reset', '--hard', `origin/${upstreamBranch}`])
    run('git', ['-C', upstreamDir, 'clean', '-fd'])
  } else {
    mkdirSync(dirname(upstreamDir), { recursive: true })
    run('git', ['clone', '--depth', '1', '--branch', upstreamBranch, upstreamUrl, upstreamDir])
  }
  return run('git', ['-C', upstreamDir, 'rev-parse', 'HEAD'])
}

function copyVendorFiles() {
  mkdirSync(vendorDir, { recursive: true })
  for (const file of compactFiles) {
    const src = join(upstreamDir, file)
    if (!existsSync(src)) continue
    const dest = join(vendorDir, file)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readFileSync(src))
  }
}

function extractConstants(goSource) {
  const known = {
    defaultCompactRatio: 'REASONIX_DEFAULT_COMPACT_RATIO',
    checkpointCeilingRatio: 'REASONIX_CHECKPOINT_CEILING_RATIO',
    recentTailBudgetRatio: 'REASONIX_RECENT_TAIL_BUDGET_RATIO',
    minRecentTailTokens: 'REASONIX_MIN_RECENT_TAIL_TOKENS',
    maxRecentTailTokens: 'REASONIX_MAX_RECENT_TAIL_TOKENS',
    summaryOutputMaxTokens: 'REASONIX_SUMMARY_OUTPUT_MAX_TOKENS',
    exceptionalMinSavingsRatio: 'REASONIX_EXCEPTIONAL_MIN_SAVINGS_RATIO',
    minRecentKeep: 'REASONIX_MIN_RECENT_KEEP',
    minCompactMessages: 'REASONIX_MIN_COMPACT_MESSAGES',
    maxPinnedFirstUserTokens: 'REASONIX_MAX_PINNED_FIRST_USER_TOKENS',
    pinnedFirstUserWindowFrac: 'REASONIX_PINNED_FIRST_USER_WINDOW_FRAC',
    maxKeptUserTurnTokens: 'REASONIX_MAX_KEPT_USER_TURN_TOKENS',
    keptUserTurnsBudgetTokens: 'REASONIX_KEPT_USER_TURNS_BUDGET_TOKENS',
    keptUserTurnsWindowFrac: 'REASONIX_KEPT_USER_TURNS_WINDOW_FRAC',
    protocolReserveTokens: 'REASONIX_PROTOCOL_RESERVE_TOKENS',
  }

  const out = {}
  for (const [goName, tsName] of Object.entries(known)) {
    const re = new RegExp(`(?:^|\\n)\\s*(?:const\\s+)?${goName}\\s*=\\s*([^\\n]+)`, 'm')
    const match = goSource.match(re)
    if (!match) throw new Error(`Could not find Go constant ${goName}`)
    const expr = match[1].trim().replace(/\/\/.*$/, '').trim()
    const value = eval(expr) // trusted upstream numeric expression, e.g. 32 * 1024
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Non-numeric value for ${goName}: ${expr}`)
    out[tsName] = value
  }

  const tagOpenMatch = goSource.match(/summaryTagOpen\s*=\s*"([^"]+)"/)
  const tagCloseMatch = goSource.match(/summaryTagClose\s*=\s*"([^"]+)"/)
  if (!tagOpenMatch || !tagCloseMatch) throw new Error('Could not find summary tag constants')
  out.REASONIX_SUMMARY_TAG_OPEN = tagOpenMatch[1]
  out.REASONIX_SUMMARY_TAG_CLOSE = tagCloseMatch[1]

  const promptMatch = goSource.match(/summarySystemPrompt\s*=\s*`([\s\S]*?)`/)
  if (!promptMatch) throw new Error('Could not find summarySystemPrompt')
  out.REASONIX_SUMMARY_INSTRUCTION = promptMatch[1]

  return out
}

function renderGenerated(commit, values) {
  const lines = [
    '/**',
    ' * AUTO-GENERATED from esengine/DeepSeek-Reasonix.',
    ' * Run `node scripts/sync-reasonix-compact.mjs` to refresh after upstream changes.',
    ' * @module dsh-compaction-cacheaware/generated/reasonix-constants',
    ' */',
    '',
    `export const REASONIX_UPSTREAM_COMMIT = ${JSON.stringify(commit)}`,
    '',
  ]
  for (const [key, value] of Object.entries(values)) {
    if (key === 'REASONIX_SUMMARY_INSTRUCTION') {
      lines.push(`export const ${key} = ${JSON.stringify(value)}`)
    } else if (typeof value === 'number') {
      lines.push(`export const ${key} = ${value}`)
    } else {
      lines.push(`export const ${key} = ${JSON.stringify(value)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function main() {
  console.log(`Syncing Reasonix compact from ${upstreamBranch} ...`)
  const commit = fetchUpstream()
  copyVendorFiles()
  const goSource = readFileSync(join(upstreamDir, 'internal/agent/compact.go'), 'utf8')
  const values = extractConstants(goSource)
  const generated = renderGenerated(commit, values)
  writeFileSync(generatedFile, generated)
  console.log(`Updated generated constants to upstream commit ${commit}`)
  console.log(`Vendored files under ${vendorDir}`)
  rmSync(upstreamDir, { recursive: true, force: true })
}

main()
