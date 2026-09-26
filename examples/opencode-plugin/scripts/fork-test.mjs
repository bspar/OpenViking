import { pluginRoot } from "./fork-build.mjs"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const scratch = mkdtempSync(join(tmpdir(), "ov-fork-tests-"))
try {
  const tests = readdirSync(join(pluginRoot, "tests")).filter(f => f.endsWith(".test.mjs"))
  const result = spawnSync(process.execPath, ["--test", ...tests.map(f => join(pluginRoot, "tests", f))], {
    cwd: pluginRoot,
    stdio: "inherit",
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENVIKING_"))), HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config"), OPENVIKING_PENDING_DIR: join(scratch, "pending"), OPENVIKING_STATE_DIR: join(scratch, "state"), OPENVIKING_CLI_CONFIG_FILE: join(scratch, "ovcli.conf"), OPENVIKING_CONFIG_FILE: join(scratch, "ov.conf") },
    timeout: 60000,
  })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
