#!/usr/bin/env node
/**
 * Sync the compatible Reasonix compact design into dsh-compaction-cacheaware.
 *
 * The upstream main-v2 branch is allowed to evolve independently. This script
 * always records where upstream is and refreshes the vendored snapshot, and it
 * writes a compatibility report describing how far the port has drifted.
 *
 * Historically this script treated any structural upstream change as a reason
 * to produce *nothing*: it printed a warning and exited, so CI opened no pull
 * request and the vendored snapshot silently rotted for weeks. It now always
 * lands the snapshot + a report, and only the *generated constant values* fall
 * back to local policy for constants upstream has removed.
 *
 * Usage:
 *   node scripts/sync-reasonix-compact.mjs
 *   node scripts/sync-reasonix-compact.mjs --from <dir>     # use a pre-fetched upstream tree
 *   node scripts/sync-reasonix-compact.mjs --report <path>  # default docs/UPSTREAM_SYNC_REPORT.md
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const upstreamUrl = 'https://github.com/esengine/DeepSeek-Reasonix.git'
const upstreamBranch = 'main-v2'
const upstreamDir = join(root, '.tmp', 'reasonix-upstream')
const vendorDir = join(root, 'vendor', 'reasonix', 'compact')
const generatedFile = join(root, 'src', 'generated', 'reasonix-constants.ts')

// Auto-discovery replaces the old hardcoded list: upstream adds compaction
// source files regularly, and a fixed list silently ignored them.
const TRACKED_SOURCE_RE = /^internal\/agent\/(?:compact|context)[a-z_]*\.go$/
const DOC_FILES = [
  'docs/research/cache-aware-compaction-design.md',
  'docs/SPEC.md',
]

// Last local value for everything the port consumes. It is the baseline the
// drift report diffs against, and the fallback used only if upstream removes a
// constant the port still imports.
//
// Constants upstream has already deleted (the checkpoint ceiling, recent-tail
// min/max, exceptional savings, first-user pinning, kept-user-turn budget — and
// the `compact_user_turns.go` that carried them) are deliberately absent: the
// port no longer has the concepts, so tracking them would recreate exactly the
// dead configuration this list exists to surface.
const LOCAL_POLICY = Object.freeze({
  REASONIX_DEFAULT_COMPACT_RATIO: 0.85,
  REASONIX_RECENT_TAIL_BUDGET_RATIO: 0.1,
  REASONIX_SUMMARY_OUTPUT_MAX_TOKENS: 16384,
  REASONIX_MIN_RECENT_KEEP: 2,
  REASONIX_MIN_COMPACT_MESSAGES: 2,
  REASONIX_PROTOCOL_RESERVE_TOKENS: 256,
})

const GO_CONSTANTS = Object.freeze({
  defaultCompactRatio: 'REASONIX_DEFAULT_COMPACT_RATIO',
  recentTailBudgetRatio: 'REASONIX_RECENT_TAIL_BUDGET_RATIO',
  summaryOutputMaxTokens: 'REASONIX_SUMMARY_OUTPUT_MAX_TOKENS',
  minRecentKeep: 'REASONIX_MIN_RECENT_KEEP',
  minCompactMessages: 'REASONIX_MIN_COMPACT_MESSAGES',
  protocolReserveTokens: 'REASONIX_PROTOCOL_RESERVE_TOKENS',
})

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
}

function fetchUpstream() {
  const from = argValue('--from')
  if (from) {
    const dir = resolve(from)
    if (!existsSync(dir)) throw new Error(`--from directory does not exist: ${dir}`)
    return { dir, commit: readCommitMarker(dir) }
  }
  if (existsSync(upstreamDir)) {
    run('git', ['-C', upstreamDir, 'fetch', 'origin', upstreamBranch])
    run('git', ['-C', upstreamDir, 'reset', '--hard', `origin/${upstreamBranch}`])
    run('git', ['-C', upstreamDir, 'clean', '-fd'])
  } else {
    mkdirSync(dirname(upstreamDir), { recursive: true })
    run('git', ['clone', '--depth', '1', '--branch', upstreamBranch, upstreamUrl, upstreamDir])
  }
  return { dir: upstreamDir, commit: run('git', ['-C', upstreamDir, 'rev-parse', 'HEAD']) }
}

/** A `--from` tree carries its commit in this sidecar when it was not produced by git. */
function readCommitMarker(dir) {
  const marker = join(dir, '.upstream-commit')
  if (existsSync(marker)) return readFileSync(marker, 'utf8').trim()
  try {
    return run('git', ['-C', dir, 'rev-parse', 'HEAD'])
  } catch {
    return 'unknown'
  }
}

function listTrackedFiles(dir) {
  const agentDir = join(dir, 'internal', 'agent')
  if (!existsSync(agentDir)) throw new Error(`upstream tree has no internal/agent: ${dir}`)
  const source = readdirSync(agentDir)
    .filter((name) => !name.endsWith('_test.go'))
    .map((name) => `internal/agent/${name}`)
    .filter((path) => TRACKED_SOURCE_RE.test(path))
    .sort()
  const docs = DOC_FILES.filter((doc) => existsSync(join(dir, doc)))
  return [...source, ...docs]
}

function copyVendorFiles(dir, files) {
  // Make vendor/ a true snapshot: files deleted upstream must not linger.
  rmSync(vendorDir, { recursive: true, force: true })
  const missing = []
  for (const file of files) {
    const src = join(dir, file)
    if (!existsSync(src)) {
      missing.push(file)
      continue
    }
    const body = readFileSync(src)
    // A `--from` tree can contain fetch artifacts (e.g. a 404 body saved under
    // the requested path). Never vendor something that is not Go source.
    if (file.endsWith('.go') && !/^package\s+[A-Za-z_]\w*/m.test(body.toString('utf8'))) {
      missing.push(`${file} (not Go source)`)
      continue
    }
    const dest = join(vendorDir, file)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, body)
  }
  return missing
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
      value = operator === '*' ? value + rhs : value - rhs
    }
    return value
  }
  const value = sum()
  if (index !== tokens.length || !Number.isFinite(value)) throw new Error(`Invalid numeric expression: ${expression}`)
  return value
}

/**
 * Extract every constant the port consumes.
 *
 * Returns `{ values, removed, drift }`; a constant missing upstream is reported
 * in `removed` and falls back to LOCAL_POLICY instead of aborting the sync.
 */
function extractConstants(goSource) {
  const values = {}
  const removed = []
  const drift = []

  for (const [goName, tsName] of Object.entries(GO_CONSTANTS)) {
    const re = new RegExp(`(?:^|\\n)\\s*(?:const\\s+)?${goName}\\s*=\\s*([^\\n]+)`, 'm')
    const match = goSource.match(re)
    if (!match) {
      removed.push(tsName)
      values[tsName] = LOCAL_POLICY[tsName]
      continue
    }
    let upstreamValue
    try {
      upstreamValue = parseNumericExpression(goSource, match[1])
    } catch (error) {
      removed.push(tsName)
      values[tsName] = LOCAL_POLICY[tsName]
      drift.push(`${tsName}: unparseable upstream expression \`${match[1].trim()}\` (${error.message})`)
      continue
    }
    values[tsName] = upstreamValue
    if (LOCAL_POLICY[tsName] !== undefined && LOCAL_POLICY[tsName] !== upstreamValue) {
      drift.push(`${tsName}: upstream ${upstreamValue} (was ${LOCAL_POLICY[tsName]} locally)`)
    }
  }

  const tagOpenMatch = goSource.match(/summaryTagOpen\s*=\s*"([^"]+)"/)
  const tagCloseMatch = goSource.match(/summaryTagClose\s*=\s*"([^"]+)"/)
  if (!tagOpenMatch || !tagCloseMatch) throw new Error('Could not find summary tag constants in upstream compact.go')
  values.REASONIX_SUMMARY_TAG_OPEN = tagOpenMatch[1]
  values.REASONIX_SUMMARY_TAG_CLOSE = tagCloseMatch[1]

  const promptMatch = goSource.match(/(?:summarySystemPrompt|compactionInstruction)\s*=\s*`([\s\S]*?)`/)
  if (!promptMatch) throw new Error('Could not find the compaction instruction in upstream compact.go')
  values.REASONIX_SUMMARY_INSTRUCTION = promptMatch[1]

  return { values, removed, drift }
}

function renderGenerated(commit, values, removed) {
  const lines = [
    '/**',
    ' * AUTO-GENERATED from esengine/DeepSeek-Reasonix.',
    ' * Run `node scripts/sync-reasonix-compact.mjs` to refresh after upstream changes.',
    ' *',
    ' * Values for constants upstream still exposes come from upstream. Constants listed in',
    ' * REASONIX_UPSTREAM_REMOVED_CONSTANTS no longer exist upstream and hold the last local',
    ' * policy value; retire them from the port. See docs/UPSTREAM_SYNC_REPORT.md.',
    ' * @module dsh-compaction-cacheaware/generated/reasonix-constants',
    ' */',
    '',
    `export const REASONIX_UPSTREAM_COMMIT = ${JSON.stringify(commit)}`,
    '',
    '/** Constants the port still consumes that upstream has removed. */',
    `export const REASONIX_UPSTREAM_REMOVED_CONSTANTS = ${JSON.stringify(removed)}`,
    '',
  ]
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'number') lines.push(`export const ${key} = ${value}`)
    else lines.push(`export const ${key} = ${JSON.stringify(value)}`)
    lines.push('')
  }
  return lines.join('\n')
}

function renderReport({ commit, previousCommit, files, missing, removed, drift }) {
  // Deliberately no generation timestamp: the workflow detects changes with
  // `git diff --quiet`, and a per-run timestamp would make every scheduled run
  // look like a change and open a PR that only bumps a date.
  const lines = [
    '# Reasonix upstream sync report',
    '',
    `- Upstream: \`esengine/DeepSeek-Reasonix\` @ \`${upstreamBranch}\``,
    `- Upstream commit: \`${commit}\``,
    `- Previous commit: \`${previousCommit || 'unknown'}\``,
    `- Vendored files: ${files.length}`,
    '',
  ]
  if (removed.length > 0) {
    lines.push(
      '## Port drift: constants removed upstream',
      '',
      'These constants are still imported by the port but no longer exist upstream.',
      'The generated module keeps the last local policy value so the package still',
      'compiles. Either retire the concepts or re-derive them from the new design.',
      '',
      ...removed.map((name) => `- \`${name}\``),
      '',
    )
  }
  if (drift.length > 0) {
    lines.push('## Upstream default changes adopted', '', ...drift.map((d) => `- ${d}`), '')
  }
  if (missing.length > 0) {
    lines.push('## Tracked files not vendored', '', ...missing.map((f) => `- \`${f}\``), '')
  }
  lines.push('## Vendored snapshot', '', ...files.map((f) => `- \`${f}\``), '')
  return lines.join('\n')
}

function readPreviousCommit() {
  if (!existsSync(generatedFile)) return undefined
  const match = readFileSync(generatedFile, 'utf8').match(/REASONIX_UPSTREAM_COMMIT\s*=\s*"([^"]+)"/)
  return match ? match[1] : undefined
}

function main() {
  const reportPath = resolve(root, argValue('--report') ?? 'docs/UPSTREAM_SYNC_REPORT.md')
  console.log(`Syncing Reasonix compact from ${upstreamBranch} ...`)
  const { dir, commit } = fetchUpstream()
  const files = listTrackedFiles(dir)
  const missing = copyVendorFiles(dir, files)
  const goSource = readFileSync(join(dir, 'internal/agent/compact.go'), 'utf8')
  const { values, removed, drift } = extractConstants(goSource)
  const previousCommit = readPreviousCommit()

  mkdirSync(dirname(generatedFile), { recursive: true })
  writeFileSync(generatedFile, renderGenerated(commit, values, removed))
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, renderReport({ commit, previousCommit, files, missing, removed, drift }))

  console.log(`Upstream commit: ${commit}`)
  console.log(`Vendored ${files.length} files under ${relative(root, vendorDir)}`)
  console.log(`Wrote ${relative(root, generatedFile)} and ${relative(root, reportPath)}`)
  if (removed.length > 0) {
    console.warn(
      `::warning::${removed.length} port constant(s) no longer exist upstream: ${removed.join(', ')}. ` +
        'Local policy values were retained so the package still builds; see the sync report.',
    )
  }
  if (missing.length > 0) {
    console.warn(`::warning::Tracked files missing upstream: ${missing.join(', ')}`)
  }
}

main()
