#!/usr/bin/env node
/**
 * Sync the compatible Reasonix compact design into dsh-compaction-cacheaware.
 *
 * The upstream main-v2 branch is allowed to evolve independently. This script
 * only creates a PR when the upstream compact.go still exposes the contract
 * understood by this TypeScript port. A structural upstream rewrite is reported
 * as a warning and intentionally produces no changes; it must be ported and
 * reviewed manually instead of being auto-vendored.
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

// These are deliberate local policy values. Upstream may change its defaults,
// but changing the TS port's trigger/tail policy requires a separate review.
const LOCAL_POLICY = Object.freeze({
  REASONIX_DEFAULT_COMPACT_RATIO: 0.85,
  REASONIX_CHECKPOINT_CEILING_RATIO: 0.5,
  REASONIX_RECENT_TAIL_BUDGET_RATIO: 0.1,
  REASONIX_MIN_RECENT_TAIL_TOKENS: 8192,
  REASONIX_MAX_RECENT_TAIL_TOKENS: 16384,
  REASONIX_SUMMARY_OUTPUT_MAX_TOKENS: 16384,
  REASONIX_EXCEPTIONAL_MIN_SAVINGS_RATIO: 0.25,
  REASONIX_MIN_RECENT_KEEP: 2,
  REASONIX_MIN_COMPACT_MESSAGES: 2,
  REASONIX_MAX_PINNED_FIRST_USER_TOKENS: 1500,
  REASONIX_PINNED_FIRST_USER_WINDOW_FRAC: 0.15,
  REASONIX_MAX_KEPT_USER_TURN_TOKENS: 1500,
  REASONIX_KEPT_USER_TURNS_BUDGET_TOKENS: 8192,
  REASONIX_KEPT_USER_TURNS_WINDOW_FRAC: 0.05,
  REASONIX_PROTOCOL_RESERVE_TOKENS: 256,
})

class IncompatibleUpstreamError extends Error {}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
}

function fetchUpstream() {
  if (existsSync(upstreamDir)) {
    run('git', ['-C', upstreamDir, 'fetch', 'origin', upstreamBranch])
    run('git', ['-C', upstreamDir, 'reset', '--hard', `origin/${upstreamBranch}`])
    run('git', ['-C', upstreamDir, 'clean', '-fd'])
  } else {
    mkdirSync(dirname(upstreamDir), { recursive: true })
    run('git', ['clone', '--depth', '1', '--branch', upstreamBranch, upstreamUrl, upstreamDir])
  }
  return run('git', ['-C', upstreamDir, 'rev-parse', 'HEAD'])
}

function copyVendorFiles() {
  // Make vendor/ a true snapshot: files deleted upstream must not linger.
  rmSync(vendorDir, { recursive: true, force: true })
  mkdirSync(vendorDir, { recursive: true })
  const skipped = []
  for (const file of compactFiles) {
    const src = join(upstreamDir, file)
    if (!existsSync(src)) {
      skipped.push(file)
      continue
    }
    const dest = join(vendorDir, file)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readFileSync(src))
  }
  if (skipped.length > 0) {
    console.warn(`::warning::Upstream compact snapshot omitted ${skipped.length} optional files: ${skipped.join(', ')}`)
  }
}

function parseNumericExpression(source, expression) {
  const expr = expression.replace(/\/\/.*$/, '').trim()
  const tokenRe = /0[xX][0-9a-fA-F]+|(?:\d+\.?(?:\d*)?|\.\d+)|[()+\-*/]/gy
  const tokens = []
  let cursor = 0
  while (cursor < expr.length) {
    if (/\s/.test(expr[cursor])) {
      cursor += 1
      continue
    }
    tokenRe.lastIndex = cursor
    const match = tokenRe.exec(expr)
    if (!match) throw new Error(`Unsupported numeric expression: ${expression}`)
    tokens.push(match[0])
    cursor = tokenRe.lastIndex
  }
  let index = 0
  const peek = () => tokens[index]
  const consume = (token) => {
    if (peek() !== token) throw new Error(`Expected ${token} in numeric expression: ${expression}`)
    index += 1
  }
  function factor() {
    if (peek() === '+') {
      index += 1
      return factor()
    }
    if (peek() === '-') {
      index += 1
      return -factor()
    }
    if (peek() === '(') {
      index += 1
      const value = sum()
      consume(')')
      return value
    }
    const token = peek()
    if (token === undefined) throw new Error(`Missing number in numeric expression: ${expression}`)
    index += 1
    return token.toLowerCase().startsWith('0x') ? Number.parseInt(token, 16) : Number(token)
  }
  function product() {
    let value = factor()
    while (peek() === '*' || peek() === '/') {
      const operator = tokens[index++]
      const rhs = factor()
      value = operator === '*' ? value * rhs : value / rhs
    }
    return value
  }
  function sum() {
    let value = product()
    while (peek() === '+' || peek() === '-') {
      const operator = tokens[index++]
      const rhs = product()
      value = operator === '+' ? value + rhs : value - rhs
    }
    return value
  }
  const value = sum()
  if (index !== tokens.length || !Number.isFinite(value)) throw new Error(`Invalid numeric expression: ${expression}`)
  return value
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
    if (!match) throw new IncompatibleUpstreamError(`Could not find compatible Go constant ${goName}`)
    out[tsName] = parseNumericExpression(goSource, match[1])
  }

  const tagOpenMatch = goSource.match(/summaryTagOpen\s*=\s*"([^"]+)"/)
  const tagCloseMatch = goSource.match(/summaryTagClose\s*=\s*"([^"]+)"/)
  if (!tagOpenMatch || !tagCloseMatch) throw new IncompatibleUpstreamError('Could not find compatible summary tag constants')
  out.REASONIX_SUMMARY_TAG_OPEN = tagOpenMatch[1]
  out.REASONIX_SUMMARY_TAG_CLOSE = tagCloseMatch[1]

  const promptMatch = goSource.match(/(?:summarySystemPrompt|compactionInstruction)\s*=\s*`([\s\S]*?)`/)
  if (!promptMatch) throw new IncompatibleUpstreamError('Could not find compatible compaction instruction')
  out.REASONIX_SUMMARY_INSTRUCTION = promptMatch[1]

  // Keep the port's deliberate trigger and retention policy; only compatible
  // upstream source metadata, tags, and prompt text are synchronized.
  return { ...out, ...LOCAL_POLICY }
}

function renderGenerated(commit, values) {
  const lines = [
    '/**',
    ' * AUTO-GENERATED from esengine/DeepSeek-Reasonix.',
    ' * Run `node scripts/sync-reasonix-compact.mjs` to refresh after upstream changes.',
    ' * Local trigger/tail policy values are intentionally preserved; review upstream policy changes separately.',
    ' * @module dsh-compaction-cacheaware/generated/reasonix-constants',
    ' */',
    '',
    `export const REASONIX_UPSTREAM_COMMIT = ${JSON.stringify(commit)}`,
    '',
  ]
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'number') lines.push(`export const ${key} = ${value}`)
    else lines.push(`export const ${key} = ${JSON.stringify(value)}`)
    lines.push('')
  }
  return lines.join('\n')
}

function main() {
  console.log(`Syncing compatible Reasonix compact from ${upstreamBranch} ...`)
  try {
    const commit = fetchUpstream()
    const goSource = readFileSync(join(upstreamDir, 'internal/agent/compact.go'), 'utf8')
    let values
    try {
      values = extractConstants(goSource)
    } catch (error) {
      if (error instanceof IncompatibleUpstreamError) {
        console.warn(`::warning::Skipping upstream commit ${commit}: ${error.message}. The main-v2 compact contract changed; manual port review is required.`)
        return
      }
      throw error
    }
    copyVendorFiles()
    writeFileSync(generatedFile, renderGenerated(commit, values))
    console.log(`Updated compatible generated constants to upstream commit ${commit}`)
    console.log(`Vendored files under ${vendorDir}`)
  } finally {
    rmSync(upstreamDir, { recursive: true, force: true })
  }
}

main()
