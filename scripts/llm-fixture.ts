export function startCommitModel() {
  const requests: string[] = []
  const message = "feat(sidebar): update the staged workspace changes"
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "commit", object: "model", owned_by: "local-test" }] })
    if (!path.endsWith("/chat/completions")) return new Response("Not found", { status: 404 })
    const body = await request.json() as { stream?: boolean; messages?: unknown }
    requests.push(JSON.stringify(body.messages))
    const base = { id: "sidebar-fixture", created: 1, model: "commit" }
    if (!body.stream) return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: message }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
    return new Response([
      { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: message }, finish_reason: null }] },
      { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } })
  return { server, requests, message }
}
