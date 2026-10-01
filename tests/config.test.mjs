import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, resolveCompactSpec } from '../lib/config.js'

const config = resolveConfig()

test('default geometry keeps Reasonix ratios when no output cap is known', () => {
  const spec = resolveCompactSpec(config, 100000)
  assert.equal(spec.thresholdTokens, 80000)
  assert.equal(spec.hardCeilingTokens, 99744)
  assert.equal(spec.recentTailTokens, 16000)
})

test('routed output reservation constrains trigger and usable tail budget', () => {
  const spec = resolveCompactSpec(config, 100000, 30000)
  assert.equal(spec.thresholdTokens, 69744)
  assert.equal(spec.hardCeilingTokens, 69744)
  assert.equal(spec.recentTailTokens, 11200)
})

test('small output reservation leaves ratio trigger intact', () => {
  const spec = resolveCompactSpec(config, 100000, 10000)
  assert.equal(spec.thresholdTokens, 80000)
  assert.equal(spec.hardCeilingTokens, 89744)
  assert.equal(spec.recentTailTokens, 14400)
})

test('tail guard uses the output-adjusted input budget', () => {
  const spec = resolveCompactSpec(resolveConfig({ recentTailRatio: 0.9 }), 100000, 20000)
  assert.equal(spec.recentTailTokens, 40000)
})

test('output plus protocol reservation must leave usable input capacity', () => {
  assert.throws(() => resolveCompactSpec(config, 100000, 99744), /no input budget/)
  assert.throws(() => resolveCompactSpec(config, 200), /no input budget/)
})

test('invalid output reservations fail explicitly', () => {
  for (const outputTokens of [-1, 1.5, NaN, Infinity, 100000, 100001]) {
    assert.throws(() => resolveCompactSpec(config, 100000, outputTokens), /outputTokens/)
  }
})
