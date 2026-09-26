import { mkdir, readFile, writeFile, rename } from "node:fs/promises"
import { join } from "node:path"
import { ROOT, SHARED_DIR, GENERATED_HEADER, directSharedImports, sharedClosure } from "../../memory-plugin-shared/sync.mjs"

// Use upstream's dependency closure while building only this package.
export const pluginRoot = join(ROOT, "examples/opencode-plugin")
const dir = join(pluginRoot, "lib/shared")
const { seeds, missing } = await directSharedImports({ root: pluginRoot, dir })
if (missing.length) throw new Error(`Missing shared imports: ${JSON.stringify(missing)}`)
await mkdir(dir, { recursive: true })
for (const name of await sharedClosure(seeds)) {
  const target = join(dir, name)
  const staging = `${target}.${process.pid}.tmp`
  await writeFile(staging, GENERATED_HEADER + await readFile(join(SHARED_DIR, name), "utf8"))
  await rename(staging, target)
}
await writeFile(join(pluginRoot, "LICENSE"), await readFile(join(ROOT, "examples/LICENSE")))
