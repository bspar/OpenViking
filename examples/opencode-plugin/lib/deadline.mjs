// Local fork, 2026-09-26: bounded optional work. Apache-2.0.
export const DEFAULT_PROMPT_TIMEOUT_MS = 2000
export const DEFAULT_CLEANUP_TIMEOUT_MS = 1000

export function budget(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.min(10000, Math.max(10, Math.floor(value))) : fallback
}

// Race as well as abort: host APIs may ignore a signal. Callers must use drafts
// and check signal before side effects following awaited work.
export async function withDeadline(operation, { timeoutMs, signals = [] }) {
  const controller = new AbortController()
  const abort = () => controller.abort(new Error("OpenViking optional work cancelled"))
  const sources = signals.filter(Boolean)
  for (const signal of sources) {
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  }
  let rejectAbort
  const interrupted = new Promise((_, reject) => { rejectAbort = reject })
  const reject = () => rejectAbort(controller.signal.reason)
  controller.signal.addEventListener("abort", reject, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  try {
    const work = Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      return operation(controller.signal)
    })
    if (controller.signal.aborted) reject()
    return await Promise.race([work, interrupted])
  } finally {
    clearTimeout(timer)
    for (const signal of sources) signal.removeEventListener("abort", abort)
    controller.signal.removeEventListener("abort", reject)
  }
}

// The event reader awaits enqueue(), providing backpressure. Reject saturation
// without claiming capture or advancing any cursor.
export function createCaptureQueue(limit = 32) {
  let tail = Promise.resolve()
  let pending = 0
  return {
    enqueue(operation, signal) {
      if (pending >= limit) return Promise.reject(new Error("OpenViking capture queue full; capture not acknowledged"))
      pending++
      const task = tail.then(() => {
        signal?.throwIfAborted()
        return operation()
      })
      tail = task.catch(() => {}).finally(() => { pending-- })
      return task
    },
    drain: () => tail,
  }
}
