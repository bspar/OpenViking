// Local fork modifications, 2026-09-26: fail-open transport and cancellation.
import { buildRecallBlock, isRecallEnabled } from "./shared/recall-core.mjs"
import { isBypassed } from "./shared/session-model.mjs"
import { effectivePeerId, fetchJSON, log } from "./utils.mjs"

export function createMemoryRecall({ config, sessionManager }) {
  async function buildRelevantMemories(input, parts) {
    if (!isRecallEnabled(config)) return
    const query = extractCurrentUserText(parts ?? [])
    if (!query) return
    if (query.length < config.minQueryLength) return
    const sessionID = input.sessionID
    if (isBypassed(config, {
      sessionId: sessionID,
      cwd: input.directory ?? input.cwd,
    })) return

    input.signal?.throwIfAborted()
    const health = await fetchJSON(config, "/health", { signal: input.signal }, { timeoutMs: 5000 })
    if (!health.ok) return

    const block = await buildRecallBlock(
      // 5s is this hook's own budget for a bare retrieval; when the request
      // also spends a server fuse the helper hands down a longer deadline, and
      // overriding it here would abort a request the server was still inside.
      async (path, init = {}, options = {}) => {
        input.signal?.throwIfAborted()
        const result = await fetchJSON(config, path, { ...init, signal: input.signal }, { ...options, timeoutMs: options.timeoutMs ?? 5000 })
        // Network failure/timeout is not evidence of an older server API.
        if (!result.ok && result.status === 0) throw new Error("OpenViking recall unavailable; skipping this turn")
        return result
      },
      config,
      query,
      {
        actorPeerId: effectivePeerId(config),
        legacyPeerId: config.effectivePeer?.legacyPeerId ?? "",
        // The mapped OV session is what turns on server-side query expansion
        // and the cross-turn dedup ledger.
        sessionId: sessionID ? sessionManager.getMappedSessionId(sessionID) : "",
        log: (stage, data) => log("DEBUG", "recall", stage, data),
      },
    )
    return block || undefined
  }

  async function injectRelevantMemories(input, output) {
    const block = await buildRelevantMemories({
      ...input,
      sessionID: input.sessionID ?? output.message?.sessionID,
    }, output.parts)
    if (block && prependSyntheticRecallPart(input, output, block)) {
      log("INFO", "recall", "Injected OpenViking context")
    }
  }

  return { buildRelevantMemories, injectRelevantMemories }
}

export function extractCurrentUserText(parts) {
  const texts = []
  for (const part of parts) {
    if (part.type !== "text" || typeof part.text !== "string") continue
    if (part.synthetic || part.ignored) continue
    if (part.text.includes("<openviking-context")) return null
    texts.push(part.text)
  }
  const joined = texts.join(" ").trim()
  return joined || null
}

function prependSyntheticRecallPart(input, output, injection) {
  const sessionID = input.sessionID ?? output.message?.sessionID
  // messageID is optional in opencode's chat.message API (messageID?: string).
  // When absent, generate a fallback so recall context is always injected.
  const messageID = input.messageID ?? output.message?.id ?? `ov-recall-${Date.now()}`
  if (!sessionID) return false

  output.parts.unshift({
    id: `prt-ov-recall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "text",
    text: injection,
    synthetic: true,
    sessionID,
    messageID,
  })
  return true
}
