import { OpenCode } from "@opencode/client"
import { mkdtemp, mkdir, symlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createServer } from "node:net"
import type { Plugin } from "@opencode/plugin/tui"
import { autoRenameClient } from "../src/auto-rename-client"

const root = resolve(import.meta.dir, "..")
const runtime = process.env.SIDEBAR_RUNTIME ? resolve(process.env.SIDEBAR_RUNTIME) : root
const temp = await mkdtemp(join(process.env.TMPDIR!, "sidebar-rename-"))
const config = join(temp, "config/opencode")
await mkdir(config, { recursive: true })
let usage = 1000
let titles = 0
let primary = 0
let holdTitle: ReturnType<typeof Promise.withResolvers<void>> | undefined
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("Not found", { status: 404 })
  const body = await request.json() as { messages: Array<{ content: unknown }>; stream?: boolean }
  const naming = JSON.stringify(body.messages).includes("Generate only a concise session title")
  const compacting = JSON.stringify(body.messages.at(-1)).includes("You MUST summarize the conversation above")
  const text = naming ? `Sidebar title ${++titles}` : compacting ? "## Objective\n- Verify sidebar naming.\n\n## Next Move\n1. Continue fixture work." : `Completed fixture turn ${++primary}`
  if (naming && holdTitle) await holdTitle.promise
  const tokens = naming ? 10 : usage
  const base = { id: crypto.randomUUID(), created: 1, model: "commit" }
  const tokenUsage = { prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens }
  if (!body.stream) return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: tokenUsage })
  return new Response([
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: tokenUsage },
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
} })
const provider = join(temp, "provider")
await mkdir(provider)
const build = await Bun.build({ entrypoints: [join(root, "scripts/commit-provider.ts")], target: "bun", format: "esm", packages: "external" })
if (!build.success) throw new Error("Fixture build failed")
await Bun.write(join(provider, "index.js"), await build.outputs[0].text())
await Bun.write(join(provider, "package.json"), '{"name":"rename-fixture","type":"module"}')
await symlink(join(runtime, "node_modules"), join(provider, "node_modules"))
await Bun.write(join(config, "opencode.json"), JSON.stringify({ plugins: [runtime, provider], model: "sidebar-test/commit", update: "disable" }))
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (!address || typeof address === "string") return reject(new Error("No port"))
    server.close(() => resolve(address.port))
  })
})
const password = crypto.randomUUID()
const server = Bun.spawn([Bun.which("opencode")!, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: temp,
  env: { PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR!, HOME: join(temp, "home"), XDG_CONFIG_HOME: join(temp, "config"), XDG_DATA_HOME: join(temp, "data"), XDG_CACHE_HOME: join(temp, "cache"), XDG_STATE_HOME: join(temp, "state"), OPENCODE_DB: join(temp, "test.db"), OPENCODE_PASSWORD: password, SIDEBAR_MODEL_URL: `http://127.0.0.1:${fixture.port}/v1` },
  stdout: Bun.file(join(temp, "server.log")), stderr: Bun.file(join(temp, "server-error.log")),
})
const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` } })
let stopNaming: (() => void) | undefined
async function wait(check: () => Promise<boolean>, name: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) { if (await check().catch(() => false)) return; await Bun.sleep(50) }
  throw new Error(`Timed out: ${name}. Diagnostics: ${temp}`)
}
try {
  await wait(async () => Boolean(await client.server.info()), "private server")
  stopNaming = autoRenameClient({ client, data: { listen(callback: Parameters<Plugin.Context["data"]["listen"]>[0]) {
    const controller = new AbortController()
    void (async () => { for await (const details of client.event.subscribe({ signal: controller.signal })) callback({ details } as Parameters<typeof callback>[0]) })().catch(() => {})
    return () => controller.abort()
  } } } as unknown as Plugin.Context)
  const session = await client.session.create({ location: { directory: temp } })
  async function turn(tokens: number, title: string, sessionID = session.id) {
    usage = tokens
    await client.session.prompt({ sessionID, text: `Continue fixture work with ${tokens} input tokens.` })
    await client.session.wait({ sessionID })
    await wait(async () => (await client.session.get({ sessionID })).title === title, title)
  }
  await turn(1000, "Sidebar title 1")
  await turn(8000, "Sidebar title 2")
  await turn(9000, "Sidebar title 2")
  await turn(17000, "Sidebar title 3")
  await turn(25000, "Sidebar title 4")
  usage = 1000
  await client.session.compact({ sessionID: session.id })
  await client.session.wait({ sessionID: session.id })
  await wait(async () => (await client.session.context({ sessionID: session.id })).some((message) => message.type === "compaction" && message.status === "completed"), "compaction complete")
  if (Number(titles) !== 4) throw new Error("Compaction alone triggered a title generation")
  await turn(8000, "Sidebar title 5")
  await client.location.reload()
  await turn(9000, "Sidebar title 5")
  await client.session.update({ sessionID: session.id, title: "My chosen title" })
  await turn(17000, "My chosen title")
  if (titles !== 5) throw new Error(`Expected 5 title generations, got ${titles}`)
  const messages = await client.session.context({ sessionID: session.id })
  if (messages.filter((message) => message.type === "user").some((message) => !message.text.startsWith("Continue fixture work"))) throw new Error("Automatic naming added chat messages")
  const raced = await client.session.create({ location: { directory: temp } })
  await turn(1000, "Sidebar title 6", raced.id)
  holdTitle = Promise.withResolvers<void>()
  usage = 8000
  await client.session.prompt({ sessionID: raced.id, text: "Continue fixture work during delayed title generation." })
  await client.session.wait({ sessionID: raced.id })
  await wait(async () => Number(titles) === 7, "delayed title request")
  await client.session.update({ sessionID: raced.id, title: "Manual title wins the race" })
  holdTitle.resolve()
  holdTitle = undefined
  await turn(17000, "Manual title wins the race", raced.id)
  if (Number(titles) !== 7) throw new Error("Raced manual title was re-enrolled")
  const resumed = await client.session.create({ location: { directory: temp } })
  await turn(1000, "Sidebar title 8", resumed.id)
  holdTitle = Promise.withResolvers<void>()
  usage = 8000
  await client.session.prompt({ sessionID: resumed.id, text: "Continue fixture work until the first quarter." })
  await client.session.wait({ sessionID: resumed.id })
  await wait(async () => Number(titles) === 9, "refresh held at 25%")
  usage = 8320
  await client.session.prompt({ sessionID: resumed.id, text: "Continue fixture work to 26% while the previous refresh is pending." })
  await client.session.wait({ sessionID: resumed.id })
  holdTitle.resolve()
  holdTitle = undefined
  await wait(async () => (await client.session.get({ sessionID: resumed.id })).title === "Sidebar title 10", "cancelled quarter retried at 26%")
  if (Number(titles) !== 10) throw new Error("Cancelled quarter was duplicated")
  await Bun.write(join(root, "artifacts/rename-verification.json"), JSON.stringify({ passed: true, runtime, titleGenerations: titles, milestones: [25, 50, 75], compactionCycle: true, reloadCheckpoint: true, manualTitlePreserved: true, concurrentManualRename: true, cancelledQuarterRetried: true, chatPromptsAdded: false, model: "isolated local fixture" }, null, 2))
  console.log("PASS: native quarter refresh, compaction/reload, manual-title protection, cancelled 25% refresh retried at 26%, no extra chat prompts")
} finally {
  holdTitle?.resolve()
  stopNaming?.()
  server.kill()
  await server.exited
  fixture.stop(true)
}
