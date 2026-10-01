import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createAssistantMessage, createDeveloperMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { CacheAwareCompactionEngine } from '../lib/engine.js'

const ROUTE = { provider: 'fixture', model: 'fixture-small' }

function messageTokens(message) {
  if (message.source.kind === 'compact-checkpoint') return 2
  if (message.role === 'system') return 5
  return 10
}

function createMeter() {
  return {
    measure(session) {
      const nodes = session.surface.nodes.map((seq) => {
        const event = session.eventAt(SessionSeq(seq))
        const message = session.deriveEventMessage(event)
        const tokens = messageTokens(message)
        return { seq, tokens, heuristicTokens: tokens * 3 }
      })
      const surfaceTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
      return { nodes, surfaceTokens, totalTokens: surfaceTokens + 5 }
    },
    estimateMessage: messageTokens,
  }
}

class FixtureCompactionEngine extends CacheAwareCompactionEngine {
  summaryCalls = 0
  summaryError

  constructor(ctx, { auto = true, summaryError } = {}) {
    super(ctx, {
      compactRatio: 0.5,
      recentTailRatio: 0.2,
      summaryMaxTokens: 128,
      minRecentKeep: 2,
      minCompactMessages: 2,
      protocolReserveTokens: 1,
      auto,
    })
    this.summaryError = summaryError
  }

  async summarize(input) {
    this.summaryCalls += 1
    assert.ok(input.messages.length > 0, 'summary request must carry selected conversation history')
    if (this.summaryError) throw this.summaryError
    return {
      summary: [{ type: 'text', text: 'Durable fact: the fixture keeps its canonical transcript.' }],
      provider: ROUTE.provider,
      model: ROUTE.model,
      maxTokens: 128,
    }
  }
}

function setup({ contextWindow = 100, defaultMaxTokens, auto = true, summaryError } = {}) {
  const ctx = new Context()
  let flushCount = 0
  ctx.provide('llm', {
    resolveModelInfo: async () => ({ context: { contextWindow }, defaultMaxTokens }),
  })
  ctx.provide('tokenMeter', createMeter())
  ctx.provide('sessions', {
    flush: async () => { flushCount += 1 },
  })
  const engine = new FixtureCompactionEngine(ctx, { auto, summaryError })
  return { ctx, engine, flushCount: () => flushCount }
}

function createSession(id, maxTokens) {
  const session = Session.create(SessionId(id))
  session.append('request/header', {
    header: { config: { ...ROUTE, ...(maxTokens === undefined ? {} : { maxTokens }) } },
    reason: 'initial',
  })
  session.append('system/message', {
    turn: 1,
    step: 1,
    message: createSystemMessage('Keep durable test constraints.'),
  }, { surfaceOp: 'append' })
  return session
}

function appendUser(session, text) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function appendAssistant(session, text, turn, step) {
  return session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: ROUTE,
    }),
    stream: [],
  }, { surfaceOp: 'append' })
}

function fixtureAgent(session) {
  return {
    session,
    options: ROUTE,
    runMaintenance(task) {
      return task(new AbortController().signal)
    },
  }
}

function visibleText(session) {
  return session.deriveMessages().flatMap((message) => message.content)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

test('manual /compact preserves canonical events, continues, and resumes from the checkpoint projection', async () => {
  const { ctx, engine, flushCount } = setup({ auto: false })
  const session = createSession('manual-compact-integration')
  for (let index = 0; index < 6; index += 1) appendUser(session, `canonical turn ${index}`)
  const canonicalBefore = session.snapshotEvents()
  const visibleBefore = session.deriveMessages()
  const agent = fixtureAgent(session)

  const result = await ctx.compaction.compactNow(agent, new AbortController().signal)

  assert.ok(result, 'manual compaction should produce a checkpoint')
  assert.equal(engine.summaryCalls, 1)
  assert.equal(flushCount(), 1, 'manual compaction must request a durability flush')
  const summaryEvent = session.snapshotEvents().find((event) => event.type === 'compaction/summary')
  assert.equal(summaryEvent.data.shadowedTokenCount, result.shadowedSeqs.length * 30,
    'durable shadow accounting uses heuristic tokens, not the 10-token routed price')
  assert.ok(session.deriveMessages().some((message) => message.source.kind === 'compact-checkpoint'),
    'the installed checkpoint has the official durable source')
  assert.deepEqual(session.snapshotEvents().slice(0, canonicalBefore.length), canonicalBefore,
    'compaction must append to the canonical log without rewriting old events')
  assert.ok(session.snapshotEvents().some((event) => event.type === 'user/message'
    && event.data.content[0]?.text === 'canonical turn 0'), 'canonical messages remain in the raw session log')
  assert.ok(session.surface.nodes.length < visibleBefore.length, 'the model-visible surface should be smaller after replacement')
  assert.match(visibleText(session), /Durable fact: the fixture keeps its canonical transcript\./)
  assert.doesNotMatch(visibleText(session), /canonical turn 0/)

  const resumed = Session.create(SessionId('manual-compact-resume'), session.snapshotEvents())
  const resumedAgent = fixtureAgent(resumed)
  const beforeResumePressure = resumed.snapshotEvents()
  assert.equal(await engine.compactIfNeeded(resumedAgent, 'pressure', new AbortController().signal), null,
    'a restored checkpoint below the automatic threshold should resume without another summary')
  assert.equal(engine.summaryCalls, 1)
  assert.deepEqual(resumed.snapshotEvents().slice(0, beforeResumePressure.length), beforeResumePressure)
  assert.match(visibleText(resumed), /Durable fact: the fixture keeps its canonical transcript\./)
  assert.ok(resumed.snapshotEvents().some((event) => event.type === 'user/message'
    && event.data.content[0]?.text === 'canonical turn 0'), 'resume retains the original canonical transcript')

  resumed.append('turn/start', { turn: 2 })
  appendUser(resumed, 'continue after compaction')
  appendAssistant(resumed, 'continued reply', 2, 1)
  resumed.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.match(visibleText(resumed), /continue after compaction/)
  assert.match(visibleText(resumed), /continued reply/)

  const resumedAgain = Session.create(SessionId('manual-compact-resume-again'), resumed.snapshotEvents())
  assert.match(visibleText(resumedAgain), /Durable fact: the fixture keeps its canonical transcript\./)
  assert.match(visibleText(resumedAgain), /continued reply/)
  assert.ok(resumedAgain.snapshotEvents().some((event) => event.type === 'user/message'
    && event.data.content[0]?.text === 'canonical turn 0'))
})

test('automatic pressure waits below compactRatio and compacts at the threshold', async () => {
  const { ctx, engine } = setup({ contextWindow: 100, auto: true })
  const session = createSession('pressure-threshold-integration')
  for (let index = 0; index < 3; index += 1) appendUser(session, `past turn ${index}`)
  session.append('turn/start', { turn: 4 })
  const agent = fixtureAgent(session)
  const signal = new AbortController().signal

  await ctx.waterfall('agent/pre-step', { agent, signal }, () => undefined)
  assert.equal(engine.summaryCalls, 0, '40 estimated tokens is below the 50-token trigger')
  appendUser(session, 'current turn part one')
  appendUser(session, 'current turn part two')
  await ctx.waterfall('agent/pre-step', { agent, signal }, () => undefined)

  assert.equal(engine.summaryCalls, 1)
  assert.ok(session.snapshotEvents().some((event) => event.type === 'compaction/summary'))
  assert.ok(createMeter().measure(session).totalTokens < 50, 'one summary should return the request below the trigger')
})

test('provider-confirmed overflow uses the automatic recovery listener below the normal pressure threshold', async () => {
  const { ctx, engine } = setup({ contextWindow: 200, auto: true })
  const session = createSession('overflow-recovery-integration')
  for (let index = 0; index < 4; index += 1) appendUser(session, `overflow history ${index}`)
  session.append('turn/start', { turn: 5 })
  assert.ok(createMeter().measure(session).totalTokens < 100, 'fixture begins below the normal pressure trigger')
  const agent = fixtureAgent(session)
  const signal = new AbortController().signal

  const decision = await ctx.waterfall('agent/request-error', {
    agent,
    failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE },
    signal,
  }, () => ({ kind: 'preserve-original-error' }))

  assert.deepEqual(decision, { kind: 'retry' }, 'successful overflow compaction should retry the original request')
  assert.equal(engine.summaryCalls, 1)
  assert.ok(session.snapshotEvents().some((event) => event.type === 'compaction/summary'))
})

test('summary failure closes the manual transaction without installing a partial checkpoint', async () => {
  const { ctx, engine, flushCount } = setup({
    auto: false,
    summaryError: new Error('fixture summarizer unavailable'),
  })
  const session = createSession('summary-failure-integration')
  for (let index = 0; index < 6; index += 1) appendUser(session, `failure history ${index}`)
  const originalSurface = [...session.surface.nodes]
  const originalMessages = session.deriveMessages()

  await assert.rejects(
    ctx.compaction.compactNow(fixtureAgent(session), new AbortController().signal),
    (error) => error.code === 'summary' && /manual compaction could not produce a smaller summary/.test(error.message),
  )

  const events = session.snapshotEvents()
  assert.equal(engine.summaryCalls, 1)
  assert.equal(flushCount(), 1, 'a closed failed transaction must also be flushed')
  assert.ok(events.some((event) => event.type === 'compaction/start'))
  assert.ok(events.some((event) => event.type === 'compaction/end' && /fixture summarizer unavailable/.test(event.data.error)))
  assert.equal(events.some((event) => event.type === 'compaction/summary'), false)
  assert.deepEqual(session.surface.nodes, originalSurface, 'failure must not replace any model-visible history')
  assert.deepEqual(session.deriveMessages(), originalMessages)
})

test('manual errors distinguish summary failures, preparation failures and maintenance admission', async () => {
  const candidateError = new Error('all summarization candidates failed: fixture/fixture-small [quota_exceeded]')
  const { ctx, engine, flushCount } = setup({ auto: false, summaryError: candidateError })
  const session = createSession('manual-error-classification')
  for (let index = 0; index < 6; index += 1) appendUser(session, `error history ${index}`)
  await assert.rejects(engine.compactNow(fixtureAgent(session), new AbortController().signal),
    (error) => error.code === 'summary' && error.message === candidateError.message && error.cause === candidateError)
  assert.equal(flushCount(), 1)
  assert.equal(session.snapshotEvents().some((event) => event.type === 'compaction/summary'), false)

  const preparationError = new Error('fixture route metadata unavailable')
  ctx.llm.resolveModelInfo = async () => { throw preparationError }
  await assert.rejects(engine.compactNow(fixtureAgent(session), new AbortController().signal),
    (error) => error === preparationError, 'admitted work failures must not become busy')

  const beforeAdmission = session.snapshotEvents().length
  const busyAgent = { ...fixtureAgent(session), runMaintenance: async () => { throw new Error('queued work') } }
  await assert.rejects(engine.compactNow(busyAgent, new AbortController().signal), { code: 'busy' })
  assert.equal(session.snapshotEvents().length, beforeAdmission, 'admission failure records no transaction')
})

test('cancellation during summary closes and flushes without replacing the surface', async () => {
  const { engine, flushCount } = setup({ auto: false })
  const session = createSession('cancel-summary-integration')
  for (let index = 0; index < 6; index += 1) appendUser(session, `cancel history ${index}`)
  const originalSurface = [...session.surface.nodes]
  const controller = new AbortController()
  const summarize = engine.summarize.bind(engine)
  engine.summarize = async (...args) => {
    const result = await summarize(...args)
    controller.abort()
    return result
  }
  await assert.rejects(engine.compactNow(fixtureAgent(session), controller.signal), { name: 'AbortError' })
  assert.deepEqual(session.surface.nodes, originalSurface)
  assert.equal(flushCount(), 1)
  assert.ok(session.snapshotEvents().some((event) => event.type === 'compaction/end'))
  assert.equal(session.snapshotEvents().some((event) => event.type === 'compaction/summary'), false)
})

test('transaction snapshots fresh route and heuristic prices after asynchronous range selection', async () => {
  const { ctx, engine } = setup({ contextWindow: 200, auto: false })
  const session = createSession('prepare-fresh-pricing')
  for (let index = 0; index < 6; index += 1) appendUser(session, `selected history ${index}`)
  const baseMeasure = ctx.tokenMeter.measure.bind(ctx.tokenMeter)
  let repriced = false
  ctx.tokenMeter.measure = (currentSession) => {
    const measured = baseMeasure(currentSession)
    if (!repriced) return measured
    const nodes = measured.nodes.map((node) => node.seq === session.surface.nodes[0] ? node
      : { ...node, tokens: node.tokens * 2, heuristicTokens: node.heuristicTokens * 2 })
    const surfaceTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
    return { ...measured, nodes, surfaceTokens, totalTokens: surfaceTokens + 5 }
  }
  ctx.llm.resolveModelInfo = async () => {
    repriced = true
    return { context: { contextWindow: 200 } }
  }
  const result = await engine.compactNow(fixtureAgent(session), new AbortController().signal)
  assert.ok(result)
  assert.equal(result.shadowedTokenCount, result.shadowedSeqs.length * 60,
    'commit must use the transaction preparation snapshot, not pre-await selection prices')
  const summary = session.snapshotEvents().find((event) => event.type === 'compaction/summary')
  assert.equal(summary.data.shadowedTokenCount, result.shadowedTokenCount)
})

test('preparation repricing cannot accept a checkpoint that increases current route pressure', async () => {
  const { ctx, engine, flushCount } = setup({ contextWindow: 200, auto: false })
  const session = createSession('prepare-route-price-drop')
  for (let index = 0; index < 6; index += 1) appendUser(session, `selected history ${index}`)
  const originalSurface = [...session.surface.nodes]
  const baseMeasure = ctx.tokenMeter.measure.bind(ctx.tokenMeter)
  let repriced = false
  ctx.tokenMeter.measure = (currentSession) => {
    const measured = baseMeasure(currentSession)
    if (!repriced) return measured
    const nodes = measured.nodes.map((node) => node.seq === originalSurface[0] ? node : { ...node, tokens: 0 })
    const surfaceTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
    return { ...measured, nodes, surfaceTokens, totalTokens: surfaceTokens + 5 }
  }
  ctx.llm.resolveModelInfo = async () => {
    repriced = true
    return { context: { contextWindow: 200 } }
  }
  await assert.rejects(engine.compactNow(fixtureAgent(session), new AbortController().signal),
    (error) => error.code === 'summary' && /checkpoint rejected/.test(error.cause?.message))
  assert.deepEqual(session.surface.nodes, originalSurface)
  assert.equal(session.snapshotEvents().some((event) => event.type === 'compaction/summary'), false)
  assert.equal(flushCount(), 1)
})

test('manual compaction rejects same-seq repricing during summarization', async () => {
  const { ctx, engine, flushCount } = setup({ auto: false })
  const session = createSession('selected-span-repriced')
  for (let index = 0; index < 6; index += 1) appendUser(session, `selected history ${index}`)
  const originalSurface = [...session.surface.nodes]
  const selectedSeq = originalSurface[1]
  const baseMeasure = ctx.tokenMeter.measure.bind(ctx.tokenMeter)
  let rewritten = false
  ctx.tokenMeter.measure = (currentSession) => {
    const measured = baseMeasure(currentSession)
    if (!rewritten) return measured
    const nodes = measured.nodes.map((node) => node.seq === selectedSeq
      ? { ...node, tokens: node.tokens + 1, heuristicTokens: node.heuristicTokens + 1 } : node)
    return { ...measured, nodes, surfaceTokens: measured.surfaceTokens + 1, totalTokens: measured.totalTokens + 1 }
  }
  const summarize = engine.summarize.bind(engine)
  engine.summarize = async (...args) => {
    const result = await summarize(...args)
    rewritten = true
    return result
  }
  await assert.rejects(engine.compactNow(fixtureAgent(session), new AbortController().signal),
    (error) => error.name === 'ManualCompactionError' && error.code === 'changed')
  assert.deepEqual(session.surface.nodes, originalSurface)
  assert.equal(session.snapshotEvents().some((event) => event.type === 'compaction/summary'), false)
  assert.ok(session.snapshotEvents().some((event) => event.type === 'compaction/end'))
  assert.equal(flushCount(), 1)
})

test('manual selected-span compaction permits new messages outside the selected range', async () => {
  const { engine } = setup({ auto: false })
  const session = createSession('selected-span-outside-append')
  for (let index = 0; index < 6; index += 1) appendUser(session, `selected history ${index}`)
  const summarize = engine.summarize.bind(engine)
  let appended
  engine.summarize = async (...args) => {
    const result = await summarize(...args)
    appended = appendUser(session, 'outside append must remain visible')
    return result
  }
  assert.ok(await engine.compactNow(fixtureAgent(session), new AbortController().signal))
  assert.ok(session.surface.nodes.includes(appended.seq))
  assert.match(visibleText(session), /outside append must remain visible/)
})

test('pressure reserves adapter default output tokens when the header has no override', async () => {
  const { engine } = setup({ contextWindow: 200, defaultMaxTokens: 160 })
  const session = createSession('default-output-budget')
  session.append('turn/start', { turn: 1 })
  for (let index = 0; index < 6; index += 1) appendUser(session, `output budget ${index}`)
  assert.ok(createMeter().measure(session).totalTokens < 100)
  assert.ok(await engine.compactIfNeeded(fixtureAgent(session), 'pressure', new AbortController().signal))
  assert.equal(engine.summaryCalls, 1)
})

test('routed request header output cap takes precedence over adapter default', async () => {
  const { engine } = setup({ contextWindow: 200, defaultMaxTokens: 160 })
  const session = createSession('header-output-budget', 10)
  for (let index = 0; index < 6; index += 1) appendUser(session, `header budget ${index}`)
  assert.equal(await engine.compactIfNeeded(fixtureAgent(session), 'pressure', new AbortController().signal), null)
  assert.equal(engine.summaryCalls, 0)
})

test('summary request preserves tool-role pairing, developer updates and temporary instruction', async () => {
  const ctx = new Context()
  const requests = []
  ctx.provide('llm', {
    listProviders: () => [],
    async *stream(options) {
      requests.push(options)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Durable summary.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const engine = new CacheAwareCompactionEngine(ctx, { auto: false })
  const session = createSession('request-tool-history')
  const callId = ToolCallId('desktop-tool-call')
  const tools = [{ name: 'lookup', description: 'lookup fixture', parameters: { type: 'object' } }]
  const header = session.append('request/header', { header: { config: ROUTE, tools }, reason: 'initial' })
  const developer = createDeveloperMessage({
    source: { kind: 'user' },
    content: [{ type: 'tool-addition', toolName: 'lookup' }],
  })
  session.append('developer/message', { turn: 1, step: 1, message: developer, headerSeq: header.seq }, { surfaceOp: 'append' })
  const assistant = createAssistantMessage({
    source: ROUTE,
    content: [{ type: 'tool-call', id: callId, name: 'lookup', arguments: '{}' }],
  })
  const toolResult = createToolResultMessage({ callId, content: [{ type: 'text', text: 'lookup result' }], isError: false })
  const attachments = createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'image', attachment: { attachmentId: `sha256:${'b'.repeat(64)}`, mediaType: 'image/png', bytes: 10, width: 1, height: 1, name: 'fixture.png' }, offloaded: true },
    { type: 'file', attachment: { attachmentId: `sha256:${'c'.repeat(64)}`, name: 'fixture.txt', bytes: 5 } },
  ] })
  const input = { messages: [...session.deriveMessages(), attachments, assistant, toolResult], tools }
  const canonicalBefore = session.snapshotEvents()
  const result = await engine.summarize(input, fixtureAgent(session), new AbortController().signal)
  assert.equal(result.summary[0].text, 'Durable summary.')
  const request = requests[0]
  assert.deepEqual(request.toolHistory, session.toolHistory())
  assert.ok(request.messages.some((message) => message.role === 'tool' && message.toolCallId === callId))
  assert.ok(request.messages.some((message) => message.role === 'developer' && message.id === developer.id))
  assert.deepEqual(request.messages.find((message) => message.id === attachments.id), attachments,
    'durable image/file references are preserved for host request projection')
  const instruction = request.messages.at(-1)
  assert.equal(instruction.role, 'user')
  assert.equal('id' in instruction, false)
  assert.equal('source' in instruction, false)
  assert.deepEqual(session.snapshotEvents(), canonicalBefore, 'one-shot summary instructions never enter the canonical log')
})

test('image output from a summarizer is rejected rather than installed as a checkpoint', async () => {
  const ctx = new Context()
  ctx.provide('llm', {
    listProviders: () => [],
    async *stream() {
      yield { type: 'block-end', index: 0, block: { type: 'image', attachment: {
        attachmentId: `sha256:${'d'.repeat(64)}`, mediaType: 'image/png', bytes: 10, width: 1, height: 1,
      } } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const engine = new CacheAwareCompactionEngine(ctx, { auto: false })
  const session = createSession('summary-image-output')
  const before = session.snapshotEvents()
  await assert.rejects(engine.summarize({ messages: session.deriveMessages() }, fixtureAgent(session)),
    (error) => error.code === 'UNSUPPORTED_CONTENT' && /cannot contain image output/.test(error.message))
  assert.deepEqual(session.snapshotEvents(), before)
})

test('checkpoint acceptance uses the conversation budget captured before summary fallback', async () => {
  const { ctx, engine } = setup({ contextWindow: 200, auto: false })
  const session = createSession('different-summary-route')
  for (let index = 0; index < 6; index += 1) appendUser(session, `fallback history ${index}`)
  let summaryFinished = false
  const lateLookups = []
  ctx.llm.resolveModelInfo = async (provider) => {
    if (summaryFinished) lateLookups.push(provider)
    return { context: { contextWindow: provider === ROUTE.provider ? 200 : 15 } }
  }
  engine.summarize = async () => {
    summaryFinished = true
    return { summary: [{ type: 'text', text: 'Durable fallback fact.' }], provider: 'auxiliary', model: 'small' }
  }
  const result = await engine.compactNow(fixtureAgent(session), new AbortController().signal)
  assert.ok(result, 'a summary from a small auxiliary route still fits the conversation window')
  assert.deepEqual(lateLookups, [], 'do not recontact a failed conversation route after a successful summary')
})

test('portable invalid-prompt fallback keeps tool results, file handles and tool updates as text', async () => {
  const ctx = new Context()
  const requests = []
  ctx.provide('llm', {
    listProviders: () => [],
    fileRequestText: (ref) => `[file ${ref.name}: read-only fixture handle]`,
    async *stream(options) {
      requests.push(options)
      if (requests.length === 1) throw new Error('invalid_prompt: fixture rejects native history')
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Portable summary.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const engine = new CacheAwareCompactionEngine(ctx, { auto: false })
  const session = createSession('portable-modern-content')
  const callId = ToolCallId('portable-tool-call')
  const input = { messages: [
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'file', attachment: {
      attachmentId: `sha256:${'a'.repeat(64)}`, name: 'fixture.txt', bytes: 5,
    } }] }),
    createDeveloperMessage({ source: { kind: 'user' }, content: [
      { type: 'tool-addition', toolName: 'lookup' }, { type: 'tool-removal', toolName: 'retired' },
    ] }),
    createAssistantMessage({ source: ROUTE, content: [{ type: 'tool-call', id: callId, name: 'lookup', arguments: '{}' }] }),
    createToolResultMessage({ callId, content: [{ type: 'text', text: 'portable lookup result' }], isError: false }),
    createAssistantMessage({ source: ROUTE, content: [{ type: 'tool-call', id: ToolCallId('empty-error-call'), name: 'lookup', arguments: '{}' }] }),
    createToolResultMessage({ callId: ToolCallId('empty-error-call'), content: [], isError: true }),
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: {
      attachmentId: `sha256:${'e'.repeat(64)}`, name: 'portable.png', mediaType: 'image/png', bytes: 10, width: 1, height: 1,
    }, offloaded: true }] }),
  ] }
  assert.equal((await engine.summarize(input, fixtureAgent(session))).summary[0].text, 'Portable summary.')
  assert.equal(requests.length, 2)
  const transcript = requests[1].messages[0]
  assert.equal(transcript.role, 'user')
  assert.equal('id' in transcript, false)
  assert.equal('source' in transcript, false)
  const text = transcript.content.map((block) => block.text).join('\n')
  assert.match(text, /portable lookup result/)
  assert.match(text, /portable-tool-call/)
  assert.match(text, /read-only fixture handle/)
  assert.match(text, /lookup/)
  assert.match(text, /retired/)
  assert.match(text, /\[tool empty-error-call error\]/)
  assert.match(text, /portable\.png/)
  assert.ok(text.includes(`sha256:${'e'.repeat(64)}`))
  assert.match(text, /offloaded/)
})
