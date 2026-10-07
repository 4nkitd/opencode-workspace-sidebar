import type { Plugin } from "@opencode/plugin/tui"

export function autoRenameClient(context: Plugin.Context) {
  const controller = new AbortController()
  const pending = new Set<string>()
  const dirty = new Set<string>()
  async function check(sessionID: string) {
    if (controller.signal.aborted) return
    if (pending.has(sessionID)) { dirty.add(sessionID); return }
    pending.add(sessionID)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)])
    try {
      const session = await context.client.session.get({ sessionID }, { signal })
      const location = session.location
      const claim = await context.client.rpc.call({ location, rpcID: "workspace-sidebar", method: "renameCheck", input: { sessionID } }, { signal })
      if (typeof claim.output !== "string" || !claim.output) return
      try {
        await context.client.session.update({ sessionID, title: "" }, { signal })
      } finally {
        await context.client.rpc.call({ location, rpcID: "workspace-sidebar", method: "renameFinish", input: { sessionID, token: claim.output } }, { signal: AbortSignal.timeout(5000) }).catch(() => {})
      }
    } catch {
      if (!controller.signal.aborted) console.warn("Workspace sidebar: automatic title refresh unavailable; existing title retained.")
    } finally {
      pending.delete(sessionID)
      if (dirty.delete(sessionID)) void check(sessionID)
    }
  }
  const stop = context.data.listen(({ details }) => {
    if (details.type === "session.execution.succeeded" || details.type === "session.renamed") void check(details.data.sessionID)
  })
  return () => { controller.abort(); dirty.clear(); stop() }
}
