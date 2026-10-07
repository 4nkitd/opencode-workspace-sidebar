import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { editorFile } from "../src/editor"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

test("Micro metadata keeps special filenames in a separate absolute argument", async () => {
  const root = await mkdtemp(join(tmpdir(), "sidebar-editor-"))
  roots.push(root)
  await Bun.write(join(root, "-a file;$(echo unsafe).ts"), "safe\n")
  const result = await editorFile(root, "-a file;$(echo unsafe).ts")
  expect(result.path.endsWith("/-a file;$(echo unsafe).ts")).toBe(true)
  expect(result.command.endsWith("/micro")).toBe(true)
})

test("Micro metadata rejects traversal and external symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "sidebar-editor-"))
  roots.push(root)
  await expect(editorFile(root, "../outside")).rejects.toThrow()
  await symlink("/etc/hosts", join(root, "outside"))
  await expect(editorFile(root, "outside")).rejects.toThrow()
})
