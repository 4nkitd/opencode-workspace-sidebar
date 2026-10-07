import { Model, Plugin, Provider } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"

export default Plugin.define({
  id: "test.workspace-sidebar.commit-model",
  async setup(context) {
    const providerID = Provider.ID.make("sidebar-test")
    const endpoint = process.env.SIDEBAR_MODEL_URL
    if (!endpoint || !endpoint.startsWith("http://127.0.0.1:")) throw new Error("Local model fixture endpoint required")
    await context.provider.transform((editor) => editor.add({
      info: {
        ...Provider.Info.empty(providerID), name: "Local commit verification", activation: "enabled",
        package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: endpoint, apiKey: "isolated-local-model-fixture" },
      },
      models: [{
        ...Model.Info.default(providerID, Model.ID.make("commit")), name: "Commit message fixture",
        capabilities: { tools: false, input: ["text"], output: ["text"] },
        limit: { context: 32000, input: 30000, output: 2000 },
      }],
    }))
    await context.model.transform((editor) => {
      editor.default.set(providerID, Model.ID.make("commit"))
    })
    await context.rpc.register(Rpc.define({ id: "sidebar-model-probe", events: {}, methods: {
      generate: { input: { type: "object", additionalProperties: false }, output: { type: "string" } },
    } }), { generate: async () => {
      const result = await context.generate.text({ model: { providerID, id: Model.ID.make("commit") }, prompt: "Local fixture transport check. Return a commit-message draft only." })
      return result.text
    } })
  },
})
