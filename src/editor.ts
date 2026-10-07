import { realpath, stat } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { safePath } from "./git"

export async function editorFile(directory: string, path: string) {
  const cwd = await realpath(directory)
  const file = await realpath(resolve(cwd, safePath(cwd, path)))
  safePath(cwd, relative(cwd, file))
  if (!(await stat(file)).isFile()) throw new Error("Only regular files can be opened in Micro")
  const command = Bun.which("micro")
  if (!command) throw new Error("Micro is not installed on the connected OpenCode server")
  return { cwd, path: file, command }
}
