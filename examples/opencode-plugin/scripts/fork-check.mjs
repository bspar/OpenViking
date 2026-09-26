import { pluginRoot } from "./fork-build.mjs"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

function check(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.name === "node_modules" || item.name === ".git") continue
    const path = join(dir, item.name)
    if (item.isDirectory()) check(path)
    else if (path.endsWith(".mjs")) {
      const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" })
      if (result.status !== 0) process.exit(result.status ?? 1)
    }
  }
}
check(pluginRoot)
