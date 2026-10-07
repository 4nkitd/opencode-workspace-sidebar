import { OpenCode } from "@opencode/client"
import { mkdir, mkdtemp, symlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { createServer } from "node:net"
import sharp from "sharp"
import { WebSocket } from "ws"
import { runGit } from "../src/git"
import { startCommitModel } from "./llm-fixture"

const root = resolve(import.meta.dir, "..")
const version = (await Bun.file(join(root, "package.json")).json()).version as string
const artifacts = join(root, "artifacts")
await mkdir(artifacts, { recursive: true })
// Projects under macOS's canonical /private temp directory are intentionally hidden.
const testBase = join(homedir(), ".cache", "opencode-workspace-sidebar", "verification")
await mkdir(testBase, { recursive: true })
const temp = await mkdtemp(join(testBase, "run-"))
const runtime = process.env.SIDEBAR_RUNTIME ? resolve(process.env.SIDEBAR_RUNTIME) : join(temp, "runtime")
if (!process.env.SIDEBAR_RUNTIME) {
  await mkdir(join(runtime, "dist"), { recursive: true })
  for (const name of ["index.js", "tui.js"]) await Bun.write(join(runtime, "dist", name), Bun.file(join(root, "dist", name)))
  await Bun.write(join(runtime, "index.ts"), 'export { default } from "./dist/index.js"\n')
  await Bun.write(join(runtime, "tui.ts"), 'export { default } from "./dist/tui.js"\n')
  await Bun.write(join(runtime, "package.json"), JSON.stringify({ name: "opencode-workspace-sidebar", version, type: "module", exports: { ".": "./dist/index.js", "./tui": "./dist/tui.js" }, dependencies: (await Bun.file(join(root, "package.json")).json()).dependencies }))
  const install = Bun.spawn([process.execPath, "install", "--production", "--ignore-scripts"], { cwd: runtime, stdout: Bun.file(join(artifacts, "runtime-install.log")), stderr: Bun.file(join(artifacts, "runtime-install-error.log")) })
  if (await install.exited !== 0) throw new Error("Runtime dependency installation failed")
}
const fixture = join(temp, "workspace")
await mkdir(join(fixture, "src/components"), { recursive: true })
await Bun.write(join(fixture, "README.md"), "# Workspace sidebar\nA real OpenCode plugin verification fixture.\n")
await Bun.write(join(fixture, "src/main.ts"), "export const greeting = 'hello'\n")
await Bun.write(join(fixture, "src/components/sidebar.ts"), "export const tabs = ['projects', 'files', 'git']\n")
await Bun.write(join(fixture, "src/components/button.tsx"), "export const Button = () => 'button'\n")
await Bun.write(join(fixture, "package.json"), '{"name":"sidebar-fixture","private":true}\n')
await Bun.write(join(fixture, "src/helpers.py"), 'print("sidebar verification")\n')
await Bun.write(join(fixture, "src/config.js"), "export const theme = 'dark'\n")
await runGit(fixture, ["init", "-b", "sidebar-tabs"])
await runGit(fixture, ["config", "user.name", "Sidebar Test"])
await runGit(fixture, ["config", "user.email", "sidebar@example.invalid"])
await runGit(fixture, ["add", "."])
await runGit(fixture, ["commit", "-m", "fixture"])
await Bun.write(join(fixture, "src/main.ts"), "export const greeting = 'welcome'\n")
await runGit(fixture, ["add", "src/main.ts"])
await Bun.write(join(fixture, "README.md"), "# Workspace sidebar\nVerified with actual keyboard and mouse input.\n")
await Bun.write(join(fixture, "src/components/new.ts"), "export const added = true\n")
const config = join(temp, "config/opencode")
const commitModel = startCommitModel()
const fixturePlugin = join(temp, "commit-provider")
await mkdir(fixturePlugin)
const fixtureBuild = await Bun.build({ entrypoints: [join(root, "scripts/commit-provider.ts")], target: "bun", format: "esm", packages: "external" })
if (!fixtureBuild.success) throw new Error("Fixture provider build failed")
await Bun.write(join(fixturePlugin, "index.js"), await fixtureBuild.outputs[0].text())
await Bun.write(join(fixturePlugin, "package.json"), '{"name":"sidebar-model-fixture","type":"module"}\n')
await symlink(join(runtime, "node_modules"), join(fixturePlugin, "node_modules"))
await mkdir(config, { recursive: true })
await Bun.write(join(config, "opencode.json"), JSON.stringify({
  plugins: [runtime, fixturePlugin], update: "disable", model: "sidebar-test/commit",
}))
await Bun.write(join(config, "cli.json"), JSON.stringify({
  plugins: [runtime], theme: { name: "opencode", mode: "dark" }, animations: false,
  ...(process.env.SIDEBAR_VERIFY_TOGGLE ? { keybinds: { "workspace-sidebar.toggle": "alt+shift+b" } } : {}),
  session: { sidebar: "hide" }, tabs: { enabled: false }, attention: { sound: false, notifications: false },
}))
const port = await freePort()
const uiPort = await freePort()
await Bun.write(join(temp, "sidebar.json"), JSON.stringify({ endpoints: { ui: `ws://127.0.0.1:${uiPort}`, backend: `ws://127.0.0.1:${await freePort()}` }, viewport: { cols: 150, rows: 44 } }))
const env = {
  PATH: process.env.PATH!, HOME: join(temp, "home"), TMPDIR: process.env.TMPDIR!, TERM: "xterm-256color",
  XDG_CONFIG_HOME: join(temp, "config"), XDG_DATA_HOME: join(temp, "data"), XDG_CACHE_HOME: join(temp, "cache"), XDG_STATE_HOME: join(temp, "state"),
  OPENCODE_DB: join(temp, "opencode.db"),
  OPENCODE_PASSWORD: crypto.randomUUID(),
  SIDEBAR_FIXTURE_KEY: "isolated-local-model-fixture",
  SIDEBAR_MODEL_URL: `http://127.0.0.1:${commitModel.server.port}/v1`,
  TERM_PROGRAM: process.env.SIDEBAR_VERIFY_EDITOR ? "vscode" : "ghostty",
}
const binary = Bun.which("opencode")!
const server = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: fixture, env, stdout: Bun.file(join(artifacts, "server.log")), stderr: Bun.file(join(artifacts, "server-error.log")) })
let ui: ReturnType<typeof Bun.spawn> | undefined
type Relay = { target: string; upstream?: WebSocket; pending: Array<string | Buffer> }
let proxy: Bun.Server<Relay> | undefined
let socket: WebSocket | undefined
let holdPreview: ReturnType<typeof Promise.withResolvers<void>> | undefined
let previewStarted = 0
let previewFinished = 0
let ghosttyWindow: string | undefined
let ghosttyPID: number | undefined
let ghosttyCaptureID: string | undefined
let capturedSettings = false
let sequence = 0
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
try {
  verification: {
  const headers = { authorization: `Basic ${btoa(`opencode:${env.OPENCODE_PASSWORD}`)}` }
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/openapi.json`, { headers })).ok, "private server")
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers })
  await client.location.get({ location: { directory: fixture } })
  await client.session.create({ location: { directory: fixture }, title: "Local model transport fixture" })
  const activated = await client.plugin.list({ location: { directory: fixture } })
  await Bun.write(join(artifacts, "fixture-plugins.json"), JSON.stringify(activated, null, 2))
  const models = await client.model.list({ location: { directory: fixture } })
  await Bun.write(join(artifacts, "fixture-models.json"), JSON.stringify(models.data.map((model) => ({ providerID: model.providerID, id: model.id })), null, 2))
  const generated = await client.rpc.call({ location: { directory: fixture }, rpcID: "sidebar-model-probe", method: "generate", input: {} })
  if (generated.output !== commitModel.message) throw new Error("Local OpenCode generation transport failed")
  const session = await client.session.create({ location: { directory: fixture }, title: "Workspace sidebar verification" })
  await client.session.create({ location: { directory: fixture }, title: "Review file tree and Git changes" })
  const second = join(temp, "second-project")
  await mkdir(second)
  await Bun.write(join(second, "README.md"), "# Second project\n")
  await runGit(second, ["init", "-b", "main"])
  await runGit(second, ["config", "user.name", "Sidebar Test"])
  await runGit(second, ["config", "user.email", "sidebar@example.invalid"])
  await runGit(second, ["add", "."])
  await runGit(second, ["commit", "-m", "second fixture"])
  await client.session.create({ location: { directory: second }, title: "Clean repository session" })
  const plain = join(temp, "plain-project")
  await mkdir(plain)
  await client.session.create({ location: { directory: plain }, title: "Non Git project session" })
  const groupedProjects = await client.project.list()
  const groupedSecond = groupedProjects.find((project) => project.canonical.endsWith("/second-project"))!
  await Bun.write(join(config, "workspace-sidebar.json"), JSON.stringify({ groups: [{ name: "Services", directories: [groupedSecond.canonical, plain] }] }))
  const plugins = await client.plugin.list({ location: { directory: fixture } })
  await Bun.write(join(artifacts, "plugins.json"), JSON.stringify(plugins, null, 2))
  const status = await client.rpc.call({ location: { directory: fixture }, rpcID: "workspace-sidebar", method: "status", input: {} })
  await Bun.write(join(artifacts, "git-status.json"), JSON.stringify(status, null, 2))
  proxy = Bun.serve<Relay>({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request, server) {
    const url = new URL(request.url)
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (server.upgrade(request, { data: { target: `ws://127.0.0.1:${port}${url.pathname}${url.search}`, pending: [] } })) return
      return new Response("WebSocket upgrade failed", { status: 400 })
    }
    const held = url.pathname.endsWith("/workspace-sidebar/diff") ? holdPreview : undefined
    if (held) { previewStarted++; await held.promise }
    const forwarded = new Request(`http://127.0.0.1:${port}${url.pathname}${url.search}`, request)
    forwarded.headers.set("accept-encoding", "identity")
    const response = await fetch(forwarded).catch(() => new Response("Test server closed", { status: 503 }))
    const headers = new Headers(response.headers)
    headers.delete("content-encoding")
    headers.delete("content-length")
    if (!held) return new Response(response.body, { status: response.status, headers })
    const body = await response.text()
    previewFinished++
    return new Response(body, { status: response.status, headers: { "content-type": "application/json" } })
  }, websocket: {
    open(ws) {
      const upstream = new WebSocket(ws.data.target, { headers })
      upstream.binaryType = "arraybuffer"
      ws.data.upstream = upstream
      upstream.onopen = () => { ws.data.pending.splice(0).forEach((message) => upstream.send(message)) }
      upstream.onmessage = (event) => ws.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer))
      upstream.onclose = () => ws.close()
      upstream.onerror = () => ws.close()
    },
    message(ws, message) {
      if (ws.data.upstream?.readyState === WebSocket.OPEN) ws.data.upstream.send(message)
      else ws.data.pending.push(message)
    },
    close(ws) { ws.data.upstream?.close() },
  } })
  await startUI(session.id)
  if (process.env.SIDEBAR_VERIFY_EDITOR) {
    await waitFor(async () => {
      const state = await call("ui.state") as { elements: Element[] }
      return state.elements.some((item) => item.id.startsWith("textarea-") && item.width > 0)
    }, "Editor terminal prompt ready")
    await call("ui.capture")
    const state = await call("ui.state") as { elements: Element[] }
    if (state.elements.some((item) => item.id.startsWith("workspace-"))) throw new Error("Workspace sidebar leaked into the editor terminal")
    if (!state.elements.some((item) => item.id.startsWith("textarea-") && item.x < 10)) throw new Error("Hidden sidebar still reserves prompt space")
    await call("ui.press", { key: "o", modifiers: { ctrl: true } })
    await waitText("Search sessions and projects")
    await capture("24-editor-terminal-no-sidebar")
    await Bun.write(join(artifacts, "editor-verification.json"), JSON.stringify({ passed: true, terminal: "vscode", sidebar: false, nativeCtrlO: true }, null, 2))
    console.log("PASS: editor terminal has no workspace sidebar or reserved width; native Ctrl+O remains")
    break verification
  }
  await waitText("Projects & Sessions")
  await assertLeftSidebar()
  const firstFrame = await call("ui.capture") as Frame
  if (firstFrame.lines.slice(0, 3).flatMap((line) => line.spans.map((span) => span.text)).join("").includes("Workspace sidebar verification")) throw new Error("Redundant native sidebar title is still visible")
  if (ghosttyWindow) await apple(`tell application "Ghostty"
    set win to first window whose id is ${quote(ghosttyWindow)}
    perform action "reload_config" on focused terminal of selected tab of win
  end tell`)
  if (ghosttyWindow && !process.env.SIDEBAR_VERIFY_TOGGLE) {
    for (const tab of [1, 2, 3, 1, 2, 3, 1]) {
      await apple(`tell application "Ghostty"
        activate window (first window whose id is ${quote(ghosttyWindow)})
        activate
      end tell
      tell application "System Events" to tell process "Ghostty" to key code ${tab === 1 ? 18 : tab === 2 ? 19 : 20} using control down`)
      await waitText(tab === 1 ? "Search sessions and projects" : tab === 2 ? "Filter visible files" : "Filter changes")
      await waitFor(async () => {
        const state = await call("ui.state") as { elements: (Element & { focused: boolean })[] }
        return state.elements.some((item) => item.id === "workspace-search" && item.focused)
      }, `Physical Ctrl+${tab} keeps sidebar focus`)
    }
    console.log("PASS: physical Ghostty Ctrl+1/2/3 repeated switching with sidebar input focused")
  }
  await capture("01-projects")
  if (process.env.SIDEBAR_VERIFY_TOGGLE) {
    const toggle = () => ghosttyWindow ? apple(`tell application "Ghostty"
      set win to first window whose id is ${quote(ghosttyWindow)}
      activate window win
      activate
    end tell
    tell application "System Events" to tell process "Ghostty" to key code 11 using {option down, shift down}`) : call("ui.press", { key: "b", modifiers: { meta: true, shift: true } })
    for (const fromChat of [false, true]) {
      if (fromChat) await call("ui.press", { key: "ESCAPE" })
      else await call("ui.press", { key: "1", modifiers: { ctrl: true } })
      await toggle()
      await waitFor(async () => {
        const state = await call("ui.state") as { elements: Element[] }
        return !state.elements.some((item) => item.id === "workspace-search") && state.elements.some((item) => item.id.startsWith("textarea-") && item.x < 10)
      }, "Alt+Shift+B collapses sidebar without reserving width")
      await toggle()
      await waitText("Projects & Sessions")
      await assertLeftSidebar()
      await call("ui.press", { key: "b", modifiers: { ctrl: true } })
      await call("ui.capture")
      await assertLeftSidebar()
    }
    await Bun.write(join(artifacts, "toggle-verification.json"), JSON.stringify({ passed: true, binding: "alt+shift+b", collapseAndReopen: true, fromChatAndSidebar: true, ctrlBDoesNotToggle: true }, null, 2))
    console.log("PASS: Alt+Shift+B collapses/reopens from chat and sidebar; Ctrl+B does not toggle")
    break verification
  }
  if (process.env.SIDEBAR_VERIFY_LAYOUT) {
    await call("ui.press", { key: "2", modifiers: { ctrl: true } })
    await waitText("README.md")
    await click("workspace-row-src/")
    await waitText("main.ts")
    const state = await call("ui.state") as { elements: Element[] }
    const entries = state.elements.filter((item) => item.id.startsWith("workspace-row-")).sort((a, b) => a.y - b.y)
    const expected = ["src/", "src/components/", "src/config.js", "src/helpers.py", "src/main.ts", "package.json", "README.md"].map((path) => `workspace-row-${path}`)
    if (entries.length !== expected.length || expected.some((id) => !entries.some((item) => item.id === id)) || entries.some((item) => item.height !== 1) || entries.some((item, index) => index > 0 && item.y - entries[index - 1].y !== 1)) throw new Error("File tree rows are not uniformly one line high")
    await capture("23-compact-file-spacing")
    await Bun.write(join(artifacts, "layout-verification.json"), JSON.stringify({ passed: true, rowHeight: 1, rowStep: 1, entries: entries.length }, null, 2))
    console.log("PASS: Files and folders have uniform one-line rows, half the previous spacing")
    break verification
  }
  if (!process.env.SIDEBAR_VERIFY_SPLIT) {
    await waitText("Services (2)")
    await capture("20-project-groups")
  }
  await call("ui.press", { key: "2", modifiers: { ctrl: true } })
  await waitText("Filter visible files")
  await assertLeftSidebar()
  await waitText("README.md")
  await capture("02-files")
  await call("ui.arrow", { direction: "right" })
  await waitText("main.ts")
  await call("ui.arrow", { direction: "left" })
  await click("workspace-row-src/")
  await waitText("main.ts")
  await click("workspace-row-src/components/")
  await waitText("sidebar.ts")
  await capture("03-expanded-tree")
  if (ghosttyWindow) {
    const finder = Bun.spawn(["swift", join(root, "scripts/window-id.swift")], { stdout: "pipe", stderr: "pipe" })
    const id = (await new Response(finder.stdout).text()).trim()
    if (await finder.exited !== 0 || !/^\d+$/.test(id)) throw new Error("Isolated Ghostty window ID not found")
    ghosttyCaptureID = id
    const screenshot = Bun.spawn(["screencapture", "-x", "-o", "-l", id, join(artifacts, "ghostty-physical-files.png")], { stderr: "pipe" })
    if (await screenshot.exited !== 0) throw new Error(await new Response(screenshot.stderr).text())
  }
  await click("workspace-row-src/main.ts")
  await waitText("export const greeting")
  await capture("04-micro-editor")
  await waitFor(async () => {
    const state = await call("ui.state") as { elements: (Element & { focused: boolean })[] }
    return state.elements.some((item) => item.id.startsWith("embeddedTerminal") && item.focused)
  }, "Micro terminal is focused")
  if (process.env.SIDEBAR_VERIFY_SPLIT) {
    await Bun.write(join(artifacts, "split-elements.json"), JSON.stringify(await call("ui.state"), null, 2))
    for (const cols of [150, 181, 100, 150]) {
      await call("ui.resize", { cols, rows: 44 })
      await waitFor(async () => {
        const state = await call("ui.state") as { elements: Element[] }
        const editor = state.elements.find((item) => item.id.startsWith("embeddedTerminal"))
        const chat = editor && state.elements.find((item) => item.clickable && item.y === editor.y && item.height === editor.height && item.x < editor.x && item.x + item.width === editor.x - 1)
        return Boolean(chat && editor && Math.abs(chat.width - (editor.width + 2)) <= 1 && editor.x === chat.x + chat.width + 1)
      }, `Equal chat/editor split at ${cols} columns`)
    }
    await capture("25-equal-chat-editor")
  }
  await call("ui.press", { key: "END", modifiers: { ctrl: true } })
  await call("ui.type", { text: "\n// Micro saved\n" })
  await call("ui.press", { key: "s", modifiers: { ctrl: true } })
  await waitFor(async () => (await Bun.file(join(fixture, "src/main.ts")).text()).includes("Micro saved"), "Micro edit/save modifies fixture")
  await call("ui.press", { key: "q", modifiers: { ctrl: true } })
  await waitFor(async () => {
    const state = await call("ui.state") as { elements: Element[] }
    return !state.elements.some((item) => item.id.startsWith("embeddedTerminal"))
  }, "Micro exits and native pane closes")
  if (process.env.SIDEBAR_VERIFY_SPLIT) {
    const state = await call("ui.state") as { elements: Element[] }
    const chat = state.elements.find((item) => item.id.startsWith("scrollbox-") && item.x >= 42 && item.y === 0)
    if (!chat || chat.width < 100) throw new Error("Closing Micro did not restore chat width")
    await Bun.write(join(artifacts, "split-verification.json"), JSON.stringify({ passed: true, ratio: "1:1", widths: [150, 181, 100], microEditSave: true, closedPaneRestoresChat: true }, null, 2))
    console.log("PASS: equal chat/editor split at multiple widths, Micro edit/save and close restores chat")
    break verification
  }
  for (const cancel of ["escape", "tab", "dialog"]) {
    console.log(`Checking delayed preview cancellation: ${cancel}`)
    await call("ui.press", { key: "3", modifiers: { ctrl: true } })
    await click("workspace-search")
    await call("ui.press", { key: "e", modifiers: { ctrl: true } })
    await call("ui.press", { key: "u", modifiers: { ctrl: true } })
    await call("ui.type", { text: "main.ts" })
    holdPreview = Promise.withResolvers<void>()
    const started = previewStarted
    const finished = previewFinished
    await click("workspace-row-Staged:src/main.ts")
    await waitFor(async () => previewStarted > started, "delayed preview request")
    if (cancel === "escape") await call("ui.press", { key: "ESCAPE" })
    if (cancel === "tab") await call("ui.press", { key: "F6" })
    if (cancel === "dialog") await call("ui.press", { key: "o", modifiers: { ctrl: true } })
    holdPreview.resolve()
    holdPreview = undefined
    await waitFor(async () => previewFinished > finished, "delayed preview response")
    await Bun.sleep(250)
    if (await call("ui.matches", { text: "export const greeting" })) throw new Error(`Cancelled preview reopened after ${cancel}`)
    if (cancel === "dialog") { await waitText("Search sessions and projects"); await call("ui.press", { key: "ESCAPE" }) }
  }
  await call("ui.press", { key: "1", modifiers: { ctrl: true } })
  await call("ui.press", { key: "3", modifiers: { ctrl: true } })
  await click("workspace-tab-git")
  await waitText("Staged")
  await waitFor(async () => {
    const state = await call("ui.state") as { elements: Element[] }
    const search = state.elements.find((item) => item.id === "workspace-search")
    const message = state.elements.find((item) => item.id === "workspace-commit-message")
    const generate = state.elements.find((item) => item.id === "workspace-generate-message")
    const commit = state.elements.find((item) => item.id === "workspace-commit")
    const first = state.elements.find((item) => item.id === "workspace-row-Staged:src/main.ts")
    return Boolean(search && message && generate && commit && first && message.y === search.y + 2 && generate.y === message.y + 1 && commit.y === generate.y && generate.height === 1 && commit.height === 1 && first.y === generate.y + 3)
  }, "Compact Git controls and single section separator")
  await capture("05-git")
  await click("workspace-stage-Changes:src/components/new.ts")
  await waitFor(async () => (await runGit(fixture, ["diff", "--cached", "--name-only"])).includes("src/components/new.ts"), "Stage button adds selected file")
  await click("workspace-unstage-Staged:src/components/new.ts")
  await waitFor(async () => !(await runGit(fixture, ["diff", "--cached", "--name-only"])).includes("src/components/new.ts"), "Unstage leaves working file intact")
  if (!(await Bun.file(join(fixture, "src/components/new.ts")).exists())) throw new Error("Unstage removed working file")
  await click("workspace-generate-message")
  await waitText("feat(sidebar): update")
  await capture("21-generated-message")
  if (!commitModel.requests.some((request) => request.includes("welcome") && request.includes("untrusted-staged-diff"))) throw new Error("Generate did not use staged changes through OpenCode")
  await click("workspace-row-Staged:src/main.ts")
  await waitText("+export const greeting")
  await capture("06-staged-diff")
  await call("ui.press", { key: "ESCAPE" })
  await click("workspace-row-Changes:src/components/new.ts")
  await waitText("+export const added")
  await call("ui.press", { key: "ESCAPE" })
  await waitFor(async () => ((await call("ui.state")) as { elements: (Element & { focused: boolean })[] }).elements.some((item) => item.id === "workspace-search" && item.focused), "Diff dialog restores sidebar focus")
  await click("workspace-commit-message")
  await waitFor(async () => ((await call("ui.state")) as { elements: (Element & { focused: boolean })[] }).elements.some((item) => item.id === "workspace-commit-message" && item.focused), "Commit message receives mouse focus")
  await call("ui.press", { key: "e", modifiers: { ctrl: true } })
  await call("ui.press", { key: "u", modifiers: { ctrl: true } })
  await call("ui.type", { text: "feat(sidebar): verified staged commit" })
  await click("workspace-commit")
  await waitFor(async () => (await runGit(fixture, ["log", "-1", "--format=%s"])).trim() === "feat(sidebar): verified staged commit", "Commit button records editable message")
  const committedMain = await runGit(fixture, ["show", "HEAD:src/main.ts"])
  if (committedMain.includes("Micro saved")) throw new Error("Commit included unstaged edits")
  if ((await runGit(fixture, ["show", "HEAD:README.md"])).includes("Verified with actual")) throw new Error("Commit included unstaged README")
  if (!(await runGit(fixture, ["status", "--porcelain"])).includes("src/components/new.ts")) throw new Error("Commit staged an untracked file automatically")
  await capture("22-staged-only-commit")
  await call("ui.press", { key: "F6" })
  await waitText("Projects & Sessions")
  await call("ui.press", { key: "F6" })
  await waitText("sidebar.ts")
  await call("ui.press", { key: "1", modifiers: { ctrl: true } })
  await waitText("Projects & Sessions")
  await call("ui.type", { text: "Review file" })
  await waitText("Review file tree")
  await capture("07-session-search")
  await call("ui.enter")
  await waitText("Review file tree and Git changes")
  await call("ui.press", { key: "o", modifiers: { ctrl: true } })
  await waitText("Search sessions and projects")
  await capture("08-native-ctrl-o")
  await call("ui.press", { key: "ESCAPE" })
  await call("ui.resize", { cols: 100, rows: 32 })
  await call("ui.press", { key: "2", modifiers: { ctrl: true } })
  await waitText("Filter visible files")
  await waitFor(async () => {
    const focusState = await call("ui.state") as { elements: (Element & { focused: boolean })[] }
    return focusState.elements.some((item) => item.id === "workspace-search" && item.focused)
  }, "Opening hidden sidebar focuses search")
  await call("ui.type", { text: "README" })
  await waitText("README.md")
  await capture("09-narrow")
  await call("ui.resize", { cols: 150, rows: 44 })
  await call("ui.press", { key: "1", modifiers: { ctrl: true } })
  await call("ui.type", { text: "second-project" })
  const projects = await client.project.list()
  const secondProject = projects.find((project) => project.canonical.endsWith("/second-project"))!
  await click(`workspace-worktrees-${secondProject.id}`)
  await waitText("second-project")
  const extra = await client.worktree.create({ projectID: secondProject.id, name: "review-worktree" })
  await waitFor(async () => {
    const state = await call("ui.state") as { elements: Element[] }
    return state.elements.some((item) => item.id === `workspace-row-worktree:${extra.directory}`)
  }, "worktree event refresh")
  await client.worktree.remove({ projectID: secondProject.id, directory: extra.directory, force: false })
  await call("ui.press", { key: "r", modifiers: { ctrl: true } })
  await waitFor(async () => {
    const state = await call("ui.state") as { elements: Element[] }
    return !state.elements.some((item) => item.id === `workspace-row-worktree:${extra.directory}`)
  }, "worktree removal refresh")
  await capture("10-project-worktrees")
  await click(`workspace-row-worktree:${secondProject.canonical}`)
  await waitText("Ask anything")
  await waitText("Projects & Sessions")
  await assertLeftSidebar()
  await capture("11-project-home")
  if (ghosttyCaptureID) {
    const screenshot = Bun.spawn(["screencapture", "-x", "-o", "-l", ghosttyCaptureID, join(artifacts, "ghostty-home-left.png")], { stderr: "pipe" })
    if (await screenshot.exited !== 0) throw new Error(await new Response(screenshot.stderr).text())
  }
  const homeFrame = await call("ui.capture") as Frame
  if (!homeFrame.lines.flatMap((line) => line.spans.map((span) => span.text)).join("").includes("second-project")) throw new Error("Project navigation did not update native home location")
  await call("ui.press", { key: "2", modifiers: { ctrl: true } })
  await waitText("README.md")
  await assertLeftSidebar()
  await capture("14-home-files")
  await click("workspace-row-README.md")
  await waitText("# Second project")
  await call("ui.press", { key: "q", modifiers: { ctrl: true } })
  await waitFor(async () => {
    const state = await call("ui.state") as { elements: Element[] }
    return !state.elements.some((item) => item.id.startsWith("embeddedTerminal"))
  }, "Home file opens Micro in an editor-only session")
  await call("ui.press", { key: "3", modifiers: { ctrl: true } })
  await waitText("Working tree clean")
  await capture("15-home-git")
  await chooseSide("Right")
  await assertRightSidebar()
  await capture("16-home-right")
  await chooseSide("Left")
  await assertLeftSidebar()
   await call("ui.press", { key: "b", modifiers: { meta: true, shift: true } })
  await waitFor(async () => {
    const state = await call("ui.state") as { elements: (Element & { focused: boolean })[] }
    return !state.elements.some((item) => item.id === "workspace-search") && state.elements.some((item) => item.id.startsWith("textarea-") && item.focused)
  }, "Sidebar toggle returns focus to home prompt")
  await call("ui.press", { key: "1", modifiers: { ctrl: true } })
  await waitText("Projects & Sessions")
  await assertLeftSidebar()
  await chooseSide("Hidden")
  await waitFor(async () => {
    const state = await call("ui.state") as { elements: Element[] }
    return !state.elements.some((item) => item.id === "workspace-search") && state.elements.some((item) => item.id.startsWith("textarea-") && item.x < 10)
  }, "Hidden sidebar setting frees prompt width")
  await capture("26-sidebar-hidden")
  await chooseSide("Left")
  await call("ui.press", { key: "1", modifiers: { ctrl: true } })
  await waitText("Projects & Sessions")
  await assertLeftSidebar()
  await call("ui.press", { key: "o", modifiers: { ctrl: true } })
  await waitText("Search sessions and projects")
  await call("ui.type", { text: "Clean repository session" })
  await call("ui.enter")
  await waitText("Clean repository session")
  await call("ui.press", { key: "3", modifiers: { ctrl: true } })
  await waitText("Working tree clean")
  await capture("12-clean-git")
  await call("ui.press", { key: "1", modifiers: { ctrl: true } })
  await call("ui.type", { text: "Non Git project session" })
  await call("ui.enter")
  await waitText("Non Git project session")
  await call("ui.press", { key: "3", modifiers: { ctrl: true } })
  await waitText("not a Git repository")
  await capture("13-non-repository")
  await chooseSide("Right")
  await assertRightSidebar()
  await capture("17-session-right")
  await stopUI()
  await startUI(session.id)
  await waitText("Projects & Sessions")
  await assertRightSidebar()
  await chooseSide("Left")
  await assertLeftSidebar()
  await capture("18-restored-left")
  console.log("PASS: packaged OpenCode TUI shortcuts, mouse, tree, previews, Git, home/session dock, selected project, settings and persisted side restored in a fresh TUI")
  await Bun.write(join(artifacts, "verification.json"), JSON.stringify({ passed: true, version: "2.0.23", fixture, runtime, screenshots: 23, regressions: ["preview cancellation: Esc, tab, Ctrl+O", "hidden sidebar search focus", "worktree create/remove refresh", "left dock on session and home", "home files/Git use selected project", "sidebar hide restores prompt focus", "/sidebar settings switches sides on home/session", "hidden placement frees prompt width", "saved position restored in a fresh TUI"] }, null, 2))
  }
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) await capture("failure").catch(() => {})
  throw error
} finally {
  holdPreview?.resolve()
  await stopUI()
  server.kill()
  await Promise.all([server.exited, ui?.exited])
  proxy?.stop(true)
  commitModel.server.stop(true)
  const log = Bun.file(join(artifacts, "server.log"))
  await Bun.write(log, (await log.text()).replace(/server password .*/g, "server password [redacted]"))
}

async function startUI(sessionID: string) {
  const basePort = process.env.SIDEBAR_VERIFY_LAYOUT || process.env.SIDEBAR_VERIFY_EDITOR || process.env.SIDEBAR_VERIFY_SPLIT || process.env.SIDEBAR_VERIFY_TOGGLE ? port : proxy!.port
  const uiEnv = { ...env, OPENCODE_DRIVE: "sidebar", OPENCODE_DRIVE_RENDERER: process.env.SIDEBAR_GHOSTTY ? "visible" : "headless", DRIVE_REGISTRY_DIR: temp }
  if (process.env.SIDEBAR_GHOSTTY) {
    ghosttyWindow = await apple(`tell application "Ghostty"
      set conf to new surface configuration
      set command of conf to ${quote(`${binary} --server http://127.0.0.1:${basePort} --session ${sessionID}`)}
      set initial working directory of conf to ${quote(fixture)}
      set environment variables of conf to {${Object.entries(uiEnv).map(([key, value]) => quote(`${key}=${value}`)).join(",")}}
      set win to new window with configuration conf
      activate window win
      activate
      return id of win
    end tell`)
    await waitFor(async () => {
      const list = Bun.spawn(["ps", "-axo", "pid=,args="], { stdout: "pipe" })
      const text = await new Response(list.stdout).text()
      await list.exited
      const command = `${binary} --server http://127.0.0.1:${basePort} --session ${sessionID}`
      const match = text.split("\n").map((line) => line.trim().match(/^(\d+)\s+(.+)$/)).find((line) => line && (line[2] === command || line[2] === `-${command}`))
      ghosttyPID = match ? Number(match[1]) : undefined
      return ghosttyPID !== undefined
    }, "Owned test TUI PID")
  }
  if (!process.env.SIDEBAR_GHOSTTY) ui = Bun.spawn([binary, "--server", `http://127.0.0.1:${basePort}`, "--session", sessionID], {
    cwd: fixture, env: uiEnv, stdout: Bun.file(join(artifacts, "ui.log")), stderr: Bun.file(join(artifacts, "ui-error.log")),
  })
  await waitFor(async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${uiPort}`)
    const ok = await new Promise<boolean>((done) => { ws.onopen = () => done(true); ws.onerror = () => done(false) })
    if (!ok) return false
    socket = ws
    socket.onmessage = (event) => {
      const response = JSON.parse(String(event.data))
      const item = pending.get(response.id)
      if (!item) return
      pending.delete(response.id)
      if (response.error) item.reject(new Error(JSON.stringify(response.error)))
      else item.resolve(response.result)
    }
    return true
  }, "TUI drive socket")
}

async function stopUI() {
  socket?.close()
  if (ghosttyWindow) {
    if (ghosttyPID) {
      try { process.kill(ghosttyPID, "SIGTERM") } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error }
    }
    await waitFor(async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${uiPort}`)
      return new Promise<boolean>((done) => { ws.onerror = () => done(true); ws.onopen = () => { ws.close(); done(false) } })
    }, "Test Ghostty TUI exits")
    await apple(`tell application "Ghostty" to close window (first window whose id is ${quote(ghosttyWindow)})`).catch(() => {})
  }
  if (ui) { ui.kill(); await ui.exited }
  socket = undefined
  ghosttyWindow = undefined
  ghosttyPID = undefined
  ui = undefined
}

async function chooseSide(side: "Left" | "Right" | "Hidden") {
  await call("ui.press", { key: "ESCAPE" })
  await call("ui.type", { text: "/sidebar" })
  await call("ui.enter")
  await waitText("Sidebar position")
  await waitFor(async () => {
    const state = await call("ui.state") as { elements: (Element & { focused: boolean })[] }
    return state.elements.some((item) => item.focused && item.id !== "workspace-search" && !item.id.startsWith("textarea-"))
  }, "Sidebar settings dialog focus")
  if (!capturedSettings) { await capture("19-sidebar-settings"); capturedSettings = true }
  await call("ui.type", { text: side })
  await call("ui.enter")
}

function quote(text: string) {
  return JSON.stringify(text)
}
async function apple(script: string) {
  const process = Bun.spawn(["osascript", "-"], { stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe" })
  const [text, error, status] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  if (status) throw new Error(error)
  return text.trim()
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

async function waitFor(check: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await Bun.sleep(200)
  }
  throw new Error(`Timed out: ${description}`)
}

function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  // The Drive legacy encoder drops Ctrl on digits; inject the terminal's CSI-u bytes.
  if (method === "ui.press" && typeof params.key === "string" && /^[123]$/.test(params.key) && (params.modifiers as { ctrl?: boolean } | undefined)?.ctrl) {
    params = { key: `\x1b[${params.key.charCodeAt(0)};5u` }
  }
  if (ghosttyWindow && method === "ui.press" && params.key === "ESCAPE") {
    return apple(`tell application "Ghostty"
      set win to first window whose id is ${quote(ghosttyWindow)}
      send key "escape" to focused terminal of selected tab of win
    end tell`).then(() => call("ui.state"))
  }
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)) }, 10000)
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value) }, reject: (error) => { clearTimeout(timer); reject(error) } })
    socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}
async function waitText(text: string) {
  await waitFor(async () => Boolean(await call("ui.matches", { text })), text)
}
type Element = { id: string; num: number; x: number; y: number; width: number; height: number; clickable: boolean; focusable?: boolean }
async function assertLeftSidebar() {
  await waitFor(async () => {
    const state = await call("ui.state") as { elements: Element[] }
    const search = state.elements.find((item) => item.id === "workspace-search")
    const prompt = state.elements.find((item) => item.id.startsWith("textarea-") && item.width > 0)
    return !!search && search.x <= 3 && !!prompt && prompt.x >= 42
  }, "Left sidebar reflow without prompt overlap")
}
async function assertRightSidebar() {
  await waitFor(async () => {
    const state = await call("ui.state") as { elements: Element[] }
    const search = state.elements.find((item) => item.id === "workspace-search")
    const prompt = state.elements.find((item) => item.id.startsWith("textarea-") && item.width > 0)
    return !!search && search.x > 50 && !!prompt && prompt.x + prompt.width <= search.x
  }, "Right sidebar reflow")
}
async function click(id: string) {
  await waitFor(async () => {
    const state = await call("ui.state") as { elements: Element[] }
    return state.elements.some((item) => item.id === id && (item.clickable || item.focusable))
  }, `Clickable ${id}`)
  for (let attempt = 0; attempt < 5; attempt++) {
    await call("ui.capture")
    const state = await call("ui.state") as { elements: Element[] }
    const item = state.elements.find((item) => item.id === id && (item.clickable || item.focusable))
    if (!item) throw new Error(`Missing clickable element ${id}: ${JSON.stringify(state.elements)}`)
    try {
      await call("ui.click", { target: item.num, x: Math.min(2, item.width - 1), y: 0 })
      return
    } catch (error) {
      if (!String(error).includes("click target is stale")) throw error
    }
  }
  throw new Error(`Repeated stale click target: ${id}`)
}

type Frame = { cols: number; rows: number; lines: { spans: { text: string; fg: number[]; bg: number[]; width: number; attributes: number }[] }[] }
async function capture(name: string) {
  const frame = await call("ui.capture") as Frame
  await Bun.write(join(artifacts, `${name}.json`), JSON.stringify(frame))
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  const rgb = (color: number[]) => `rgb(${color.slice(0, 3).join(",")})`
  const body = frame.lines.map((line, y) => {
    let x = 0
    return line.spans.map((span) => {
      const offset = x
      x += span.width
      return `<rect x="${offset * 10}" y="${y * 21}" width="${span.width * 10}" height="21" fill="${rgb(span.bg)}"/><text x="${offset * 10}" y="${y * 21 + 16}" fill="${rgb(span.fg)}" font-weight="${span.attributes & 1 ? 700 : 400}">${escape(span.text)}</text>`
    }).join("")
  }).join("")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.cols * 10}" height="${frame.rows * 21}"><rect width="100%" height="100%" fill="#131313"/><g font-family="JetBrainsMono Nerd Font Mono,monospace" font-size="16" xml:space="preserve">${body}</g></svg>`
  await sharp(Buffer.from(svg)).png().toFile(join(artifacts, `${name}.png`))
  console.log(`Captured ${name}`)
}
