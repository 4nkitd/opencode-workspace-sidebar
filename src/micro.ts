import type { Plugin } from "@opencode/plugin/tui"
import { EmbeddedTerminalRenderable, type Renderable } from "@opentui/core"
import { balanceEditorPane } from "./editor-layout"

const layouts = new WeakMap<Plugin.Context, () => void>()

export function stopMicroLayout(context: Plugin.Context) {
  layouts.get(context)?.()
  layouts.delete(context)
}

export async function openMicro(context: Plugin.Context, directory: string, path: string, sessionID: string | undefined, cancelled: () => boolean) {
  const origin = context.ui.router.current()
  const sameOrigin = () => {
    const current = context.ui.router.current()
    return current.type === origin.type && (origin.type !== "session" || current.type === "session" && current.sessionID === origin.sessionID)
  }
  const info = await context.client.server.info()
  if (info.capabilities?.persistentPty === false) throw new Error("This server does not support persistent terminal panes")
  const metadata = await context.client.rpc.call({ rpcID: "workspace-sidebar", method: "editor", location: { directory }, input: { path } })
  const file: unknown = metadata.output
  if (!file || typeof file !== "object" || !("path" in file) || typeof file.path !== "string" || !("command" in file) || typeof file.command !== "string" || !("cwd" in file) || typeof file.cwd !== "string") throw new Error("Invalid Micro file metadata")
  if (cancelled() || !sameOrigin()) return
  const target = sessionID ?? (await context.client.session.create({ location: { directory }, title: `Edit ${path.split("/").pop()}` })).id
  if (cancelled() || !sameOrigin()) return
  if (!sessionID) {
    await context.data.session.sync(target)
    if (cancelled() || !sameOrigin()) return
    context.ui.router.navigate({ type: "session", sessionID: target })
  }
  const stopped = () => {
    const current = context.ui.router.current()
    return cancelled() || current.type !== "session" || current.sessionID !== target
  }
  await waitFor(() => context.keymap.commands().some((command) => command.id === "terminal.toggle"), stopped)
  if (stopped()) return
  if (terminal(context.renderer.root)) {
    context.keymap.dispatch("terminal.toggle")
    await waitFor(() => !terminal(context.renderer.root), stopped)
  }
  if (stopped()) return
  const created = await context.client.experimental.persistentPty.create({
    sessionID: target, command: file.command, args: [file.path], cwd: file.cwd, title: `Micro · ${path.split("/").pop()}`, env: {},
  })
  if (stopped()) return created.id
  context.keymap.dispatch("terminal.toggle")
  await waitFor(() => terminal(context.renderer.root) !== undefined, stopped)
  if (!stopped()) {
    stopMicroLayout(context)
    const editor = terminal(context.renderer.root)
    const cleanup = editor && balanceEditorPane(editor, context.app.version)
    if (cleanup) layouts.set(context, cleanup)
    context.keymap.dispatch("pane.focus.right")
  }
  return created.id
}

function terminal(node: Renderable): EmbeddedTerminalRenderable | undefined {
  if (!node.visible || node.isDestroyed) return
  if (node instanceof EmbeddedTerminalRenderable) return node
  for (const child of node.getChildren()) {
    const found = terminal(child)
    if (found) return found
  }
}

async function waitFor(check: () => boolean, cancelled: () => boolean) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (cancelled() || check()) return
    await new Promise<void>((done) => setTimeout(done, 30))
  }
  throw new Error("Native terminal pane did not become ready")
}
