import { expect, test } from "bun:test"
import type { SessionTitle } from "@opencode/plugin/promise/session"
import type { SessionInfo, SessionMessageInfo, TokenUsageInfo, V2Event } from "@opencode/client"
import { autoRename, contextQuarter, renameCheckpoint } from "../src/auto-rename"

const tokens = (input: number): TokenUsageInfo => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
const assistant = (id: string, input: number): SessionMessageInfo => ({ id, type: "assistant", agent: "build", model: { providerID: "fixture", id: "model" }, content: [], tokens: tokens(input), time: { created: 1, completed: 2 } })
const idle: SessionMessageInfo = { id: "idle", type: "idle", outcome: "succeeded", time: { created: 3 } }
const compaction: SessionMessageInfo = { id: "compact", type: "compaction", status: "completed", reason: "manual", summary: "Fixture summary", recent: "msg", time: { created: 3 } }

test("quarters use latest context tokens including cache, not cumulative spend", () => {
  expect([0, 2499, 2500, 5000, 7500, 10000, 20000].map((value) => contextQuarter(tokens(value), 10000))).toEqual([0, 0, 1, 2, 3, 4, 4])
  expect(contextQuarter({ input: 1000, output: 100, reasoning: 100, cache: { read: 1000, write: 300 } }, 10000)).toBe(1)
  expect(contextQuarter(tokens(NaN), 10000)).toBe(0)
  expect(contextQuarter(tokens(-1), 10000)).toBe(0)
  expect(contextQuarter(tokens(100), 0)).toBe(0)
  expect(contextQuarter(tokens(100), Infinity)).toBe(0)
})

test("compaction only resets the cycle for a later completed assistant message", () => {
  expect(renameCheckpoint([assistant("old", 8000), compaction, idle])).toEqual({ cycle: "compact", assistant: undefined })
  expect(renameCheckpoint([assistant("old", 8000), compaction, assistant("new", 2500), idle]).assistant?.id).toBe("new")
})

async function fixture(options: { existing?: string; directory?: string; parentID?: string } = {}) {
  const session = { id: "ses_test", title: options.existing, parentID: options.parentID, location: { directory: options.directory ?? "/fixture" }, time: { created: 0, updated: 0 } } as SessionInfo
  let messages: SessionMessageInfo[] = []
  let titleHook: (event: SessionTitle) => Promise<void>
  const storage = new Map<string, unknown>()
  const waiting: Array<(event: V2Event | undefined) => void> = []
  const queued: V2Event[] = []
  let generate = async () => ({ text: "Generated title" })
  const context = {
    location: { directory: "/fixture" },
    session: {
      get: async () => ({ ...session }), context: async () => messages,
      hook: async (_name: string, callback: typeof titleHook) => { titleHook = callback; return { dispose: async () => {} } },
    },
    model: { list: async () => ({ data: [{ providerID: "fixture", id: "model", limit: { context: 10000 } }] }) },
    generate: { text: () => generate() },
    storage: { get: async (key: string) => storage.get(key), set: async (key: string, value: unknown) => { storage.set(key, structuredClone(value)) } },
    event: { async *subscribe({ signal }: { signal: AbortSignal }) {
      signal.addEventListener("abort", () => waiting.splice(0).forEach((resolve) => resolve(undefined)), { once: true })
      while (!signal.aborted) {
        const event = queued.shift() ?? await new Promise<V2Event | undefined>((resolve) => waiting.push(resolve))
        if (!event) break
        yield event
      }
    } },
  } as unknown as Parameters<typeof autoRename>[0]
  const naming = await autoRename(context)
  async function emit(type: string, data: Record<string, unknown> = {}) {
    const event = { type, data: { sessionID: session.id, ...data } } as V2Event
    const next = waiting.shift()
    if (next) next(event); else queued.push(event)
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  async function nativeTitle() {
    const event = { sessionID: session.id, model: { providerID: "fixture", id: "model" }, system: [], messages: [], options: {}, result: undefined as string | undefined }
    await titleHook(event as unknown as SessionTitle)
    if (event.result && event.result !== session.title) {
      session.title = event.result
      await emit("session.renamed", { title: session.title })
    }
    return event.result
  }
  return { naming, session, storage, emit, nativeTitle, setMessages: (value: SessionMessageInfo[]) => { messages = value }, setGenerate: (value: typeof generate) => { generate = value } }
}

test("one claim across clients; skipped quarters coalesce and compaction repeats", async () => {
  const f = await fixture()
  try {
    await f.nativeTitle()
    f.setMessages([assistant("first", 8000), idle])
    const claims = await Promise.all([f.naming.check(f.session.id), f.naming.check(f.session.id)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    await f.nativeTitle()
    await f.naming.finish(f.session.id, claims[0])
    expect(await f.naming.check(f.session.id)).toBe("")
    f.setMessages([compaction, idle])
    expect(await f.naming.check(f.session.id)).toBe("")
    f.setMessages([compaction, assistant("new", 2500), idle])
    expect(await f.naming.check(f.session.id)).not.toBe("")
  } finally { await f.naming.dispose() }
})

test("manual titles, other projects and children are never adopted", async () => {
  for (const options of [{ existing: "My title" }, { directory: "/elsewhere" }, { parentID: "ses_parent" }]) {
    const f = await fixture(options)
    try {
      expect(await f.nativeTitle()).toBeUndefined()
      f.setMessages([assistant("first", 10000), idle])
      expect(await f.naming.check(f.session.id)).toBe("")
    } finally { await f.naming.dispose() }
  }
})

test("manual rename after claim is preserved without generating", async () => {
  const f = await fixture()
  try {
    await f.nativeTitle()
    f.setMessages([assistant("first", 2500), idle])
    expect(await f.naming.check(f.session.id)).not.toBe("")
    f.session.title = "Manual title"
    await f.emit("session.renamed", { title: f.session.title })
    f.setGenerate(async () => { throw new Error("Must not generate") })
    expect(await f.nativeTitle()).toBe("Manual title")
    expect(await f.naming.check(f.session.id)).toBe("")
  } finally { await f.naming.dispose() }
})

test("running or permission-blocked turns do not claim a rename", async () => {
  const f = await fixture()
  try {
    await f.nativeTitle()
    f.setMessages([assistant("first", 10000)])
    expect(await f.naming.check(f.session.id)).toBe("")
    f.setMessages([assistant("first", 10000), idle])
    const token = await f.naming.check(f.session.id)
    expect(token).not.toBe("")
    await f.emit("session.execution.started")
    f.setGenerate(async () => { throw new Error("Must not generate") })
    expect(await f.nativeTitle()).toBe("Generated title")
  } finally { await f.naming.dispose() }
})

test("cancelled quarter remains eligible on the next completed turn", async () => {
  const f = await fixture()
  try {
    await f.nativeTitle()
    f.setMessages([assistant("quarter", 2500), idle])
    const token = await f.naming.check(f.session.id)
    expect(token).not.toBe("")
    await f.emit("session.execution.started")
    await f.nativeTitle()
    await f.naming.finish(f.session.id, token)
    f.setMessages([assistant("next-turn", 2600), idle])
    const retry = await f.naming.check(f.session.id)
    expect(retry).not.toBe("")
    f.setGenerate(async () => ({ text: "Updated title" }))
    await f.nativeTitle()
    await f.naming.finish(f.session.id, retry)
    expect(f.session.title).toBe("Updated title")
    f.setMessages([assistant("later", 2700), idle])
    expect(await f.naming.check(f.session.id)).toBe("")
  } finally { await f.naming.dispose() }
})

test("failed generation does not complete a milestone; unchanged successful title does", async () => {
  const f = await fixture()
  try {
    await f.nativeTitle()
    f.setMessages([assistant("quarter", 2500), idle])
    const token = await f.naming.check(f.session.id)
    f.setGenerate(async () => ({ text: "" }))
    await f.nativeTitle()
    await f.naming.finish(f.session.id, token)
    const retry = await f.naming.check(f.session.id)
    expect(retry).not.toBe("")
    f.setGenerate(async () => ({ text: "Generated title" }))
    await f.nativeTitle()
    await f.naming.finish(f.session.id, retry)
    expect(await f.naming.check(f.session.id)).toBe("")
  } finally { await f.naming.dispose() }
})
