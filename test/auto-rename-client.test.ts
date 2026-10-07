import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { autoRenameClient } from "../src/auto-rename-client"

async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve() }

function fixture() {
  let listen: Parameters<Plugin.Context["data"]["listen"]>[0]
  let checks = 0
  let finishes = 0
  const finish = Promise.withResolvers<void>()
  const stop = autoRenameClient({
    data: { listen(callback: typeof listen) { listen = callback; return () => {} } },
    client: {
      session: { get: async () => ({ location: { directory: "/fixture" } }), update: async () => {} },
      rpc: { async call({ method }: { method: string }) {
        if (method === "renameCheck") return { output: ++checks === 1 ? "claim" : "" }
        finishes++
        await finish.promise
        return { output: true }
      } },
    },
  } as unknown as Plugin.Context)
  const emit = () => listen({ details: { type: "session.execution.succeeded", data: { sessionID: "ses_test" } } } as Parameters<typeof listen>[0])
  return { emit, finish, stop, checks: () => checks, finishes: () => finishes }
}

test("completion events during delayed finish coalesce into a follow-up check", async () => {
  const f = fixture()
  try {
    f.emit()
    await flush()
    expect(f.finishes()).toBe(1)
    f.emit()
    f.emit()
    expect(f.checks()).toBe(1)
    f.finish.resolve()
    await flush()
    expect(f.checks()).toBe(2)
  } finally { f.finish.resolve(); f.stop() }
})

test("unloading suppresses a queued follow-up check", async () => {
  const f = fixture()
  f.emit()
  await flush()
  f.emit()
  f.stop()
  f.finish.resolve()
  await flush()
  expect(f.checks()).toBe(1)
})
