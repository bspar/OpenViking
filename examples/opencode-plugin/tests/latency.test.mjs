import test from "node:test"
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareV2Prompt, startV2Plugin, captureV2Context } from "../lib/v2-plugin.mjs"
import { createMemoryRecall } from "../lib/memory-recall.mjs"
import { createMemorySessionManager } from "../lib/memory-session.mjs"
import { contextMessageEvents } from "../lib/v2-events.mjs"
import { createCaptureQueue, withDeadline } from "../lib/deadline.mjs"
import { createOvHttp } from "../lib/shared/ov-http.mjs"
import { buildRecallBlockDetailed, contextRequestTimeoutMs } from "../lib/shared/recall-core.mjs"

const config = { enabled: true, autoRecall: true, endpoint: "http://mock.invalid", timeoutMs: 30000, minQueryLength: 3, user: "fictional-user", recallPeerScope: "all" }
const sessionManager = { getMappedSessionId: () => "fictional-session" }
const event = () => ({ sessionID: "fictional", messageID: "fictional-message", prompt: { text: "fictional diagnostic query" } })
const emptyProfile = { buildSessionContext: async () => undefined }

test("upstream core regression fixture: 18 requests and 75-second failure budget", async () => {
  const calls = []
  await buildRecallBlockDetailed(async (path, init, opts = {}) => {
    calls.push({ path, budget: opts.timeoutMs ?? 5000 })
    return { ok: false, status: 0, error: { aborted: true } }
  }, config, "fictional query", { sessionId: "fictional-session" })
  assert.equal(calls.length, 18)
  assert.equal(calls[0].budget, 30000)
  assert.equal(calls[1].path, "/api/v1/search/recall")
  assert.ok(calls.slice(2).every(c => c.budget === 5000))
  assert.equal(30000 + 5000 + (calls.length - 2) / 2 * 5000, 75000)
})

test("per-request config does not replace the new whole-prompt budget", () => {
  assert.equal(contextRequestTimeoutMs({ ...config, recallTimeoutMs: 1000 }, { session_id: "test" }), 30000)
  assert.equal(contextRequestTimeoutMs({ ...config, recallContextTimeoutMs: 1000 }, { session_id: "test" }), 1000)
})

test("transport failure skips recall without fallback fan-out and admits original text", async (t) => {
  const paths = []
  t.mock.method(globalThis, "fetch", async url => {
    paths.push(new URL(url).pathname)
    if (paths.at(-1) === "/health") return Response.json({ status: "ok" })
    throw new TypeError("mock unavailable")
  })
  const prompt = event()
  await prepareV2Prompt(prompt, { recall: createMemoryRecall({ config, sessionManager }), recallEnabled: true, sessionInject: emptyProfile })
  assert.deepEqual(paths, ["/health", "/api/v1/search/search"])
  assert.equal(prompt.metadata, undefined)
  assert.equal(prompt.prompt.text, "fictional diagnostic query")
})

test("HTTP 404 still uses compatibility fallback and returns successful memory", async (t) => {
  const paths = []
  t.mock.method(globalThis, "fetch", async url => {
    const path = new URL(url).pathname
    paths.push(path)
    if (path === "/health") return Response.json({ status: "ok" })
    if (path === "/api/v1/search/search") return Response.json({}, { status: 404 })
    return Response.json({ result: { rendered: "fictional memory" } })
  })
  const prompt = event()
  await prepareV2Prompt(prompt, { recall: createMemoryRecall({ config, sessionManager }), recallEnabled: true, sessionInject: emptyProfile })
  assert.match(prompt.metadata.openviking.context[0], /fictional memory/)
  assert.deepEqual(paths, ["/health", "/api/v1/search/search", "/api/v1/search/recall"])
})

test("one total deadline includes initialization, profile and recall; late work cannot inject", async () => {
  const prompt = event()
  let recallSignal
  const start = performance.now()
  await prepareV2Prompt(prompt, {
    timeoutMs: 70, ready: sleep(20), recallEnabled: true,
    sessionInject: { buildSessionContext: async () => { await sleep(20); return "profile" } },
    recall: { buildRelevantMemories: async ({ signal }) => { recallSignal = signal; await sleep(90); return "late memory" } },
  })
  assert.ok(performance.now() - start < 125, "serial work must share the deadline")
  assert.equal(recallSignal.aborted, true)
  assert.equal(prompt.metadata, undefined)
  await sleep(90)
  assert.equal(prompt.metadata, undefined, "late completion must not mutate the admitted prompt")
})

test("slow health is inside prompt deadline and abort reaches fetch", async (t) => {
  const paths = []
  let aborted = false
  t.mock.method(globalThis, "fetch", async (url, { signal }) => {
    paths.push(new URL(url).pathname)
    try { await sleep(200, undefined, { signal }) }
    catch (error) { aborted = signal.aborted; throw error }
    return Response.json({ status: "ok" })
  })
  const prompt = event()
  await prepareV2Prompt(prompt, { timeoutMs: 25, recall: createMemoryRecall({ config, sessionManager }), recallEnabled: true, sessionInject: emptyProfile })
  await sleep(0)
  assert.equal(aborted, true)
  assert.deepEqual(paths, ["/health"])
  assert.equal(prompt.metadata, undefined)
})

test("caller cancellation aborts HTTP, including response body consumption", async (t) => {
  const controller = new AbortController()
  let requestSignal
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    requestSignal = signal
    return { ok: true, status: 200, json: async () => { controller.abort(); await sleep(5); return { result: {} } } }
  })
  const result = await createOvHttp({ baseUrl: "http://mock.invalid" })("/health", { signal: controller.signal })
  assert.equal(requestSignal.aborted, true)
  assert.equal(result.ok, false)
  assert.equal(result.error.aborted, true)
})

test("already cancelled prompt starts no optional work", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await prepareV2Prompt(event(), { signal: controller.signal, sessionInject: { buildSessionContext: async () => { calls++ } } })
  assert.equal(calls, 0)
})

test("capture queue bounds pending work, remains serial, and skips expired queued work", async () => {
  const queue = createCaptureQueue(2)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const safety = setTimeout(release, 200)
  const active = queue.enqueue(() => gate)
  let captured = false
  const cancelled = withDeadline(signal => queue.enqueue(() => { captured = true }, signal), { timeoutMs: 20 })
  await sleep(0)
  await assert.rejects(queue.enqueue(async () => {}), /queue full/)
  await assert.rejects(cancelled)
  release()
  clearTimeout(safety)
  await active
  await queue.drain()
  assert.equal(captured, false)
})

test("capture cursor is not acknowledged if local persistence fails", async () => {
  const cursors = new Map()
  let stored = false
  const ctx = { session: { context: async () => [{ id: "one", type: "user", text: "fictional" }] }, storage: { set: async () => { stored = true } } }
  await assert.rejects(captureV2Context(ctx, { handleEvent: async () => {}, persistCapture: async () => { throw new Error("disk full") } }, cursors, "test"), /disk full/)
  assert.equal(stored, false)
  assert.equal(cursors.size, 0)
})

test("busy background capture does not block prompt admission; cleanup is bounded", async () => {
  const hooks = {}
  let stopped = false
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const runtime = {
    config: { mcp: { enabled: false }, autoRecall: false, cleanupTimeoutMs: 20 },
    ready: Promise.resolve(), stop: () => { stopped = true },
    repoContext: { getRepoSystemPrompt: () => "", refreshRepos: async () => {} },
    sessionInject: emptyProfile, recall: {},
    sessionManager: { handleEvent: async () => { entered(); await sleep(150) }, flushAll: async () => {} },
  }
  const ctx = { session: { hook: async (name, fn) => { hooks[name] = fn }, context: async () => [] }, event: { subscribe: () => (async function* () { yield { type: "session.execution.succeeded", data: { sessionID: "test" } } })() } }
  const cleanup = await startV2Plugin(ctx, runtime, { pluginRoot: "/fictional" })
  await started
  const promptStart = performance.now()
  await hooks.prompt(event())
  assert.ok(performance.now() - promptStart < 100)
  const cleanupStart = performance.now()
  await cleanup()
  assert.ok(performance.now() - cleanupStart < 100)
  assert.equal(stopped, true)
  await sleep(160)
})

test("acknowledged prefix is persisted and not resent after a partial batch failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ov-capture-prefix-"))
  const sizes = []
  let persistedPrefix = 0
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.endsWith("/messages/batch")) {
      sizes.push(JSON.parse(init.body).messages.length)
      if (sizes.length === 2) {
        const saved = JSON.parse(await readFile(join(directory, "openviking-session-state.json"), "utf8"))
        persistedPrefix = saved.sessions.test.messages.filter(([, message]) => message.captured).length
        return Response.json({}, { status: 400 })
      }
    }
    return Response.json({ result: { pending_tokens: 0 } })
  })
  const manager = createMemorySessionManager({ config: { ...config, autoCapture: true, captureAssistantTurns: true, captureMode: "semantic", captureMaxLength: 24000, commitTokenThreshold: 20000 }, pluginRoot: directory })
  try {
    for (let i = 0; i < 101; i++) {
      for (const e of contextMessageEvents("test", { id: `msg-${i}`, type: "user", text: `Fictional feature request number ${i}` })) await manager.handleEvent(e)
    }
    await manager.flushSession("test")
    await manager.flushSession("test")
    assert.deepEqual(sizes, [100, 1, 1])
    assert.equal(persistedPrefix, 100, "first batch must be persisted before the second request")
  } finally {
    manager.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test("compaction deadline does not acknowledge a late host snapshot", async () => {
  const hooks = {}
  let captured = 0
  let checkpointed = false
  const runtime = {
    config: { mcp: { enabled: false }, captureBoundaryTimeoutMs: 20 },
    ready: Promise.resolve(),
    repoContext: {}, recall: {}, sessionInject: emptyProfile,
    sessionManager: { handleEvent: async () => { captured++ }, flushAll: async () => {} },
  }
  const ctx = {
    session: { hook: async (name, fn) => { hooks[name] = fn }, context: async () => { await sleep(100); return [{ id: "late", type: "user", text: "fictional" }] } },
    storage: { set: async () => { checkpointed = true } },
  }
  const cleanup = await startV2Plugin(ctx, runtime, { pluginRoot: "/fictional" })
  await hooks.compaction({ sessionID: "test" })
  await sleep(110)
  assert.equal(captured, 0)
  assert.equal(checkpointed, false)
  await cleanup()
})

test("unload cancels an active prompt without waiting for its remaining budget", async () => {
  const hooks = {}
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let requestSignal
  const runtime = {
    config: { mcp: { enabled: false }, autoRecall: true, promptTimeoutMs: 500 },
    ready: Promise.resolve(), repoContext: {}, sessionInject: emptyProfile,
    recall: { buildRelevantMemories: async ({ signal }) => { requestSignal = signal; entered(); await sleep(200, undefined, { signal }); return "late" } },
    sessionManager: { flushAll: async () => {} },
  }
  const ctx = { session: { hook: async (name, fn) => { hooks[name] = fn } } }
  const cleanup = await startV2Plugin(ctx, runtime, { pluginRoot: "/fictional" })
  const prompt = event()
  const pending = hooks.prompt(prompt)
  await started
  await cleanup()
  await pending
  assert.equal(requestSignal.aborted, true)
  assert.equal(prompt.metadata, undefined)
})
