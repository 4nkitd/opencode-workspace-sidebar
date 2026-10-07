import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitCommit, gitDiff, gitGenerateMessage, gitStage, gitStatus, gitUnstage, parseStatus, preview, runGit, safePath } from "../src/git"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "workspace-sidebar-test-"))
  roots.push(root)
  await runGit(root, ["init", "-b", "main"])
  await runGit(root, ["config", "user.name", "Sidebar Test"])
  await runGit(root, ["config", "user.email", "sidebar@example.invalid"])
  return root
}

test("parses staged, unstaged, conflicts, renames and filenames with whitespace", () => {
  expect(parseStatus("MM src/a.ts\0?? new file.ts\0R  renamed.ts\0old.ts\0UU conflict.ts\0 D deleted.ts\0")).toEqual([
    { path: "src/a.ts", status: "M", group: "Staged" },
    { path: "src/a.ts", status: "M", group: "Changes" },
    { path: "new file.ts", status: "?", group: "Changes" },
    { path: "renamed.ts", original: "old.ts", status: "R", group: "Staged" },
    { path: "conflict.ts", status: "U", group: "Conflicts" },
    { path: "deleted.ts", status: "D", group: "Changes" },
  ])
})

test("reads actual staged and working patches without modifying index", async () => {
  const root = await repo()
  await mkdir(join(root, "src"))
  await Bun.write(join(root, "src/main.ts"), "first\n")
  await runGit(root, ["add", "src/main.ts"])
  await runGit(root, ["commit", "-m", "fixture"])
  await Bun.write(join(root, "src/main.ts"), "second\n")
  await runGit(root, ["add", "src/main.ts"])
  await Bun.write(join(root, "src/main.ts"), "third\n")
  const before = await runGit(root, ["ls-files", "--stage"])
  expect((await gitStatus(join(root, "src"))).changes).toHaveLength(2)
  expect(await gitDiff(root, "src/main.ts", true)).toContain("+second")
  expect(await gitDiff(root, "src/main.ts", false)).toContain("+third")
  expect(await runGit(root, ["ls-files", "--stage"])).toBe(before)
})

test("untracked previews handle literal pathspec filenames", async () => {
  const root = await repo()
  await Bun.write(join(root, ":(glob)*.ts"), "literal\n")
  expect(await gitDiff(root, ":(glob)*.ts", false)).toContain("+literal")
})

test("staged rename diffs preserve original path and actual edits", async () => {
  const root = await repo()
  const text = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n") + "\n"
  await Bun.write(join(root, "before.txt"), text)
  await runGit(root, ["add", "."])
  await runGit(root, ["commit", "-m", "before rename"])
  await runGit(root, ["mv", "before.txt", "after.txt"])
  await Bun.write(join(root, "after.txt"), text.replace("line 10", "edited line"))
  await runGit(root, ["add", "after.txt"])
  const status = await gitStatus(root)
  expect(status.changes[0].original).toBe("before.txt")
  const diff = await gitDiff(root, "after.txt", true)
  expect(diff).toContain("rename from before.txt")
  expect(diff).toContain("rename to after.txt")
  expect(diff).toContain("+edited line")
  expect(diff).not.toContain("new file mode")
})

test("rejects paths outside the project and escaping symlinks", async () => {
  const root = await repo()
  expect(() => safePath(root, "../outside")).toThrow()
  expect(() => safePath(root, "/etc/passwd")).toThrow()
  await symlink("/etc/hosts", join(root, "escape"))
  await expect(preview(root, "escape")).rejects.toThrow()
})

test("bounds preview size and detects binary content", async () => {
  const root = await repo()
  await Bun.write(join(root, "large"), "x".repeat(150000))
  await Bun.write(join(root, "binary"), new Uint8Array([10, 0, 20]))
  expect((await preview(root, "large")).length).toBeLessThan(132000)
  expect(await preview(root, "large")).toContain("truncated")
  expect(await preview(root, "binary")).toContain("Binary")
})

test("reports non-repositories as errors instead of a clean working tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "sidebar-no-repo-"))
  roots.push(root)
  await expect(gitStatus(root)).rejects.toThrow()
})

test("stages only the requested literal path and rejects traversal", async () => {
  const root = await repo()
  await Bun.write(join(root, ":(glob)*"), "literal\n")
  await Bun.write(join(root, "other"), "other\n")
  await gitStage(root, ":(glob)*")
  const changes = (await gitStatus(root)).changes
  expect(changes).toContainEqual({ path: ":(glob)*", status: "A", group: "Staged" })
  expect(changes).toContainEqual({ path: "other", status: "?", group: "Changes" })
  await expect(gitStage(root, "../escape")).rejects.toThrow()
})

test("unstages without changing the worktree, including in an unborn repository", async () => {
  const root = await repo()
  await Bun.write(join(root, "new file"), "contents\n")
  await gitStage(root, "new file")
  await gitUnstage(root, "new file")
  expect(await Bun.file(join(root, "new file")).text()).toBe("contents\n")
  expect((await gitStatus(root)).changes).toContainEqual({ path: "new file", status: "?", group: "Changes" })
})

test("stages both sides of a rename and commits only staged content", async () => {
  const root = await repo()
  await Bun.write(join(root, "before"), "base\n")
  await gitStage(root, "before")
  await gitCommit(root, "initial")
  await runGit(root, ["mv", "before", "after"])
  await Bun.write(join(root, "unrelated"), "leave out\n")
  await gitStage(root, "after")
  const sha = await gitCommit(root, "rename: move file")
  expect(sha).toMatch(/^[0-9a-f]{40,}$/)
  expect(await runGit(root, ["show", "--format=", "--name-status", "HEAD"])).toContain("after")
  expect((await gitStatus(root)).changes).toContainEqual({ path: "unrelated", status: "?", group: "Changes" })
})

test("commit refuses empty staged changes and message generation bounds input without invoking model", async () => {
  const root = await repo()
  await expect(gitCommit(root, "empty")).rejects.toThrow("no staged changes")
  await expect(gitGenerateMessage(root, { providerID: "local", id: "test" }, async () => "unused")).rejects.toThrow("Stage changes")
})
