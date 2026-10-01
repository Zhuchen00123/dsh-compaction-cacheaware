import test from 'node:test'
import assert from 'node:assert/strict'
import { selectReasonixRange } from '../lib/selection.js'

function event(seq, type, data) {
  return { seq, type, data }
}

function mockSession({ surfaceNodes, events, messages }) {
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  return {
    // The session exposes its log through `eventAt(seq)`, not an `events`
    // property; the official tool-pairing helpers read it the same way.
    eventAt: (seq) => bySeq.get(seq),
    seq: Math.max(...events.map((e) => e.seq)) + 1,
    surface: { nodes: surfaceNodes, replaceGeneration: 0, contentGeneration: 0 },
    deriveMessages() {
      if (messages) return messages
      return surfaceNodes.map((seq) => {
        const e = bySeq.get(seq)
        if (!e) return { role: 'user', content: [] }
        if (e.type === 'user/message') return { role: 'user', content: e.data.content }
        if (e.type === 'assistant/message') return { role: 'assistant', content: e.data.message.content }
        if (e.type === 'tool/result') return { role: 'tool', content: e.data.message.content }
        return { role: 'user', content: [] }
      })
    },
  }
}

// Only the fields selection.ts still reads: the pinned-first-user knobs were
// removed with upstream's geometry layer, and pinnedPrefixEnd no longer takes
// the config at all.
const config = {
  minRecentKeep: 2,
  minCompactMessages: 2,
}
const spec = { recentTailTokens: 12, contextWindow: 1000 }
const meter = { estimateMessage: () => 1 }

test('selectReasonixRange throws when token-meter surface mismatches session surface', () => {
  const events = [
    event(100, 'user/message', { content: [{ type: 'text', text: 'hello' }] }),
    event(101, 'assistant/message', { message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } }),
    event(102, 'tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }),
    event(103, 'user/message', { content: [{ type: 'text', text: 'next' }] }),
    event(104, 'assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } }),
  ]
  const session = mockSession({ surfaceNodes: [100, 101, 102, 103, 104], events })
  const measurement = {
    nodes: [
      { seq: 100, tokens: 1, heuristicTokens: 3 },
      { seq: 101, tokens: 10, heuristicTokens: 30 },
      { seq: 102, tokens: 10, heuristicTokens: 30 },
      { seq: 999, tokens: 1, heuristicTokens: 3 }, // mismatch
      { seq: 104, tokens: 1, heuristicTokens: 3 },
    ],
    surfaceTokens: 23,
    totalTokens: 23,
  }
  assert.throws(() => selectReasonixRange(session, measurement, config, spec, meter, false), /token-meter surface does not match/)
})

test('selectReasonixRange never returns a tail starting with a tool result', () => {
  const events = [
    event(100, 'user/message', { content: [{ type: 'text', text: 'hello' }] }),
    event(101, 'assistant/message', { message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } }),
    event(102, 'tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }),
    event(103, 'user/message', { content: [{ type: 'text', text: 'next' }] }),
    event(104, 'assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } }),
  ]
  const session = mockSession({ surfaceNodes: [100, 101, 102, 103, 104], events })
  const measurement = {
    nodes: [
      { seq: 100, tokens: 1, heuristicTokens: 3 },
      { seq: 101, tokens: 10, heuristicTokens: 30 },
      { seq: 102, tokens: 10, heuristicTokens: 30 },
      { seq: 103, tokens: 1, heuristicTokens: 3 },
      { seq: 104, tokens: 1, heuristicTokens: 3 },
    ],
    surfaceTokens: 23,
    totalTokens: 23,
  }
  const compactSpec = { ...spec, recentTailTokens: 2 }
  const result = selectReasonixRange(session, measurement, config, compactSpec, meter, false)
  assert.ok(result, 'fixture must produce a useful compactable range')
  const selected = measurement.nodes.slice(result.startIdx, result.endIdx + 1)
  assert.equal(result.shadowedRouteTokenCount, selected.reduce((sum, node) => sum + node.tokens, 0))
  assert.equal(result.shadowedTokenCount, selected.reduce((sum, node) => sum + node.heuristicTokens, 0))
  assert.equal(result.shadowedTokenCount, result.shadowedRouteTokenCount * 3)
  const tailStartSeq = measurement.nodes[result.endIdx + 1]?.seq
  const tailEvent = session.eventAt(tailStartSeq)
  assert.notEqual(tailEvent?.type, 'tool/result', 'tail must not start with an orphan tool result')
})
