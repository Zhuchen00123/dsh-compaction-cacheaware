import test from 'node:test'
import assert from 'node:assert/strict'
import { selectReasonixRange } from '../lib/selection.js'

function event(seq, type, data) {
  return { seq, type, data }
}

function mockSession({ surfaceNodes, events, messages }) {
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  const sparseEvents = []
  for (const e of events) sparseEvents[e.seq] = e
  return {
    events: sparseEvents,
    surface: { nodes: surfaceNodes, replaceGeneration: 0 },
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

const config = {
  maxPinnedFirstUserTokens: 100,
  pinnedFirstUserWindowFrac: 0.01,
  minRecentKeep: 2,
  minCompactMessages: 2,
}
const spec = { recentTailTokens: 12, contextWindow: 1000 }
const meter = { estimateMessage: () => 1 }

test('selectReasonixRange throws when token-meter surface mismatches session surface', () => {
  const events = [
    event(100, 'user/message', { content: [{ type: 'text', text: 'hello' }] }),
    event(101, 'assistant/message', { message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } }),
    event(102, 'tool/result', { message: { toolCallId: 'c1', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] } }),
    event(103, 'user/message', { content: [{ type: 'text', text: 'next' }] }),
    event(104, 'assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } }),
  ]
  const session = mockSession({ surfaceNodes: [100, 101, 102, 103, 104], events })
  const measurement = {
    nodes: [
      { seq: 100, tokens: 1 },
      { seq: 101, tokens: 10 },
      { seq: 102, tokens: 10 },
      { seq: 999, tokens: 1 }, // mismatch
      { seq: 104, tokens: 1 },
    ],
    surfaceTokens: 23,
    totalTokens: 23,
  }
  assert.throws(() => selectReasonixRange(session, measurement, config, spec, meter), /token-meter surface does not match/)
})

test('selectReasonixRange never returns a tail starting with a tool result', () => {
  const events = [
    event(100, 'user/message', { content: [{ type: 'text', text: 'hello' }] }),
    event(101, 'assistant/message', { message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } }),
    event(102, 'tool/result', { message: { toolCallId: 'c1', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] } }),
    event(103, 'user/message', { content: [{ type: 'text', text: 'next' }] }),
    event(104, 'assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } }),
  ]
  const session = mockSession({ surfaceNodes: [100, 101, 102, 103, 104], events })
  const measurement = {
    nodes: [
      { seq: 100, tokens: 1 },
      { seq: 101, tokens: 10 },
      { seq: 102, tokens: 10 },
      { seq: 103, tokens: 1 },
      { seq: 104, tokens: 1 },
    ],
    surfaceTokens: 23,
    totalTokens: 23,
  }
  const result = selectReasonixRange(session, measurement, config, spec, meter)
  // With the small mock the selection may return null (not enough compactable
  // span) or a valid range; it must never shadow an assistant tool-call while
  // leaving its tool/result as the first tail node.
  if (result !== null) {
    const tailStartSeq = measurement.nodes[result.endIdx + 1]?.seq
    const tailEvent = session.events[tailStartSeq]
    assert.notEqual(tailEvent?.type, 'tool/result', 'tail must not start with an orphan tool result')
  }
})
