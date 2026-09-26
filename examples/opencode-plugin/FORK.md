# Bounded-latency OpenCode V2 fork

Modified 2026-09-26, based on upstream OpenViking commit
`3e02c6ac29842be214fa1560dfaf6ea39a69322c`, the source of
`@openviking/opencode-plugin@2026.9.25-2` (source manifest version `0.5.2`).
The existing patch was ported from extracted-tree commit
`3bd9a215aef1793b6dd3a0b14a9c9c42fe2c7208`; that extraction's independent
history is not an ancestor of this branch. This branch retains OpenViking's
upstream history and full repository tree.

The plugin and shared example code remain Apache-2.0 under `examples/LICENSE`.
The full repository retains its original root license and other components'
licenses. Packaging copies **examples/LICENSE**, not the server's root license.
The package is private, named `openviking-opencode-plugin-local`, version
`2026.9.25-2.local.1`; GitHub source publication does not publish an npm release.

## Changes and limits

- One 2,000 ms V2 prompt deadline covers readiness, profile/archive injection,
  recall health/retrieval/fallback and body consumption. Optional work fails open
  and late results cannot mutate the admitted prompt.
- Transport failure ends recall; genuine HTTP compatibility fallbacks remain
  inside the same deadline. Caller, lifetime and deadline cancellation reach HTTP.
- Capture runs on the asynchronous event reader, with a serial queue capped at
  32 active/queued operations. Compaction capture has a separate 250 ms allowance,
  including queue wait; expired queued work is skipped.
- Cleanup has a 1,000 ms grace period before aborting plugin HTTP work. Incomplete
  cleanup reports `cleanupCompleted:false`. Local tool/context guards do not
  await capture initialization on each step.
- Local capture state is persisted before the host cursor advances; each
  acknowledged batch prefix is persisted before another batch is sent.

These are asynchronous budgets subject to event-loop scheduling, not preemption
of synchronous filesystem or CPU work. V2's documented prompt hook does not
promise a cancellation signal; a host-supplied signal is honored when available.
V1 compatibility remains, but whole-hook hardening is specifically V2.

There is no exactly-once guarantee: lost responses and the remote-accept/local-
crash window can duplicate writes. Queue admission is not durable; expired
compaction or cleanup can leave uncaptured data. Queue bounds do not bound host
event buffering, transcript bytes, retained session metadata or the disk pending
queue. Existing pending replay limits and multi-instance state-file limitations
remain. HTTP completion does not verify remote extraction. Server/provider
latency and embedding queues are unchanged.

## Configuration

These fields are under `plugin.opencode` in `ovcli.conf`:

| Key | Default | Accepted range | Environment override |
| --- | ---: | ---: | --- |
| `promptTimeoutMs` | 2000 | 100–10000 | `OPENVIKING_PROMPT_TIMEOUT_MS` |
| `cleanupTimeoutMs` | 1000 | 100–10000 | `OPENVIKING_CLEANUP_TIMEOUT_MS` |
| `captureBoundaryTimeoutMs` | 250 | 100–1000 | `OPENVIKING_CAPTURE_BOUNDARY_TIMEOUT_MS` |
| `captureQueueLimit` | 32 | 1–128 | none |

Recall and capture switches remain independent. `autoCapture:false` disables
capture; a zero commit threshold is clamped and is not an off switch. To disable
automatic context, use `autoRecall:false`, `noAutoInject:true`, `repoContext:false`.
Per-request timeout settings cannot extend the whole-prompt budget.

## Build and verify

From the repository root, with Node.js 22+:

```sh
npm --prefix examples/opencode-plugin test
npm --prefix examples/opencode-plugin run check
npm pack ./examples/opencode-plugin
```

Builds generate the shared dependency closure from canonical shared source.
Tests use isolated configuration, pending/state directories and fictional
fixtures. They do not exercise a live deployment. To load this source in OpenCode
V2, build it and use the absolute `examples/opencode-plugin` directory in `plugins`.
Deployment and configuration reload are a separate, deliberate step.

## Pull upstream changes

`upstream` points to `https://github.com/volcengine/OpenViking.git`; `origin`
should point to the owner's actual GitHub fork. Work on
`fix/opencode-bounded-latency`; leave the fork's default branch available for
upstream tracking. After a clean working-tree check:

```sh
git switch fix/opencode-bounded-latency
git fetch origin
git merge --ff-only origin/fix/opencode-bounded-latency
git fetch upstream
git merge --no-commit upstream/main
```

Review and resolve conflicts, including upstream equivalents of these fixes.
Regenerate shared copies with `node examples/memory-plugin-shared/sync.mjs`;
review all generated changes, run the plugin checks above and relevant shared
tests, then commit any pending merge and push the feature branch normally.
Never merge an extracted-tree root commit or replace the root tree with an
extraction. No force push is needed. Abort an unresolved merge with
`git merge --abort`.

An already loaded extracted checkout is a separate deployment. Updating this
branch does not update that checkout: review/import a source-only delta or
explicitly switch the configured plugin directory after verification. Avoid
changing loaded source and generated files during a running session.
