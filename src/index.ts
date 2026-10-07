import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { gitCommit, gitDiff, gitGenerateMessage, gitStage, gitStatus, gitUnstage, preview } from "./git"
import { editorFile } from "./editor"
import { autoRename } from "./auto-rename"

const pathInput = { type: "object", properties: { path: { type: "string", minLength: 1 } }, required: ["path"], additionalProperties: false }
const operationErrors = { operation_failed: { type: "object", required: ["message"], properties: { message: { type: "string" } }, additionalProperties: false } }

const sidebar = Rpc.define({
  id: "workspace-sidebar",
  events: {},
  methods: {
    renameCheck: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "string" },
    },
    renameFinish: {
      input: { type: "object", properties: { sessionID: { type: "string" }, token: { type: "string" } }, required: ["sessionID", "token"], additionalProperties: false },
      output: { type: "boolean" },
    },
    status: {
      input: { type: "object", additionalProperties: false },
      errors: { not_repository: { type: "object", additionalProperties: false } },
      output: {
        type: "object", required: ["root", "branch", "changes"],
        properties: {
          root: { type: "string" }, branch: { type: "string" },
          changes: { type: "array", items: { type: "object", required: ["path", "status", "group"], properties: {
            path: { type: "string" }, original: { type: "string" }, status: { type: "string" }, group: { enum: ["Staged", "Changes", "Conflicts"] },
          } } },
        },
      },
    },
    preview: {
      input: { type: "object", properties: { path: { type: "string", minLength: 1 } }, required: ["path"], additionalProperties: false },
      output: { type: "string" },
    },
    diff: {
      input: {
        type: "object", properties: { path: { type: "string", minLength: 1 }, staged: { type: "boolean" } },
        required: ["path", "staged"], additionalProperties: false,
      },
      output: { type: "string" },
    },
    stage: { input: pathInput, errors: operationErrors, output: { type: "string" } },
    editor: { input: pathInput, errors: operationErrors, output: {
      type: "object", required: ["cwd", "path", "command"], properties: { cwd: { type: "string" }, path: { type: "string" }, command: { type: "string" } }, additionalProperties: false,
    } },
    unstage: { input: pathInput, errors: operationErrors, output: { type: "string" } },
    commit: {
      input: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
      errors: operationErrors, output: { type: "string" },
    },
    generateCommitMessage: {
      input: { type: "object", properties: { model: { type: "object", properties: { providerID: { type: "string" }, id: { type: "string" }, variant: { type: "string" } }, required: ["providerID", "id"], additionalProperties: false } }, required: ["model"], additionalProperties: false },
      errors: operationErrors, output: { type: "string" },
    },
  },
})

export default Plugin.define({
  id: "local.workspace-sidebar.server",
  async setup(context) {
    const naming = await autoRename(context)
    await context.rpc.register(sidebar, {
      renameCheck: (input) => {
        if (!input || typeof input !== "object" || !("sessionID" in input) || typeof input.sessionID !== "string") throw new Error("Invalid rename check")
        return naming.check(input.sessionID)
      },
      renameFinish: async (input) => {
        if (!input || typeof input !== "object" || !("sessionID" in input) || typeof input.sessionID !== "string" || !("token" in input) || typeof input.token !== "string") throw new Error("Invalid rename completion")
        await naming.finish(input.sessionID, input.token)
        return true
      },
      status: async (_input, call) => gitStatus(context.location.directory, call.signal).catch((error: unknown) => {
        if (String(error).includes("not a git repository")) return call.error("not_repository", "This folder is not a Git repository", {})
        throw error
      }),
      preview: (input) => {
        if (!input || typeof input !== "object" || !("path" in input) || typeof input.path !== "string") throw new Error("Invalid preview request")
        return preview(context.location.directory, input.path)
      },
      diff: (input, call) => {
        if (!input || typeof input !== "object" || !("path" in input) || typeof input.path !== "string" || !("staged" in input) || typeof input.staged !== "boolean") throw new Error("Invalid diff request")
        return gitDiff(context.location.directory, input.path, input.staged, call.signal)
      },
      stage: (input, call) => {
        if (!input || typeof input !== "object" || !("path" in input) || typeof input.path !== "string") throw new Error("Invalid stage request")
        return gitStage(context.location.directory, input.path).catch((error: unknown) => call.error("operation_failed", error instanceof Error ? error.message : String(error), { message: error instanceof Error ? error.message : String(error) }))
      },
      editor: (input, call) => {
        if (!input || typeof input !== "object" || !("path" in input) || typeof input.path !== "string") throw new Error("Invalid editor request")
        return editorFile(context.location.directory, input.path).catch((error: unknown) => call.error("operation_failed", String(error), { message: String(error) }))
      },
      unstage: (input, call) => {
        if (!input || typeof input !== "object" || !("path" in input) || typeof input.path !== "string") throw new Error("Invalid unstage request")
        return gitUnstage(context.location.directory, input.path).catch((error: unknown) => call.error("operation_failed", error instanceof Error ? error.message : String(error), { message: error instanceof Error ? error.message : String(error) }))
      },
      commit: (input, call) => {
        if (!input || typeof input !== "object" || !("message" in input) || typeof input.message !== "string") throw new Error("Invalid commit request")
        return gitCommit(context.location.directory, input.message).catch((error: unknown) => call.error("operation_failed", error instanceof Error ? error.message : String(error), { message: error instanceof Error ? error.message : String(error) }))
      },
      generateCommitMessage: (input, call) => {
        if (!input || typeof input !== "object" || !("model" in input) || !input.model || typeof input.model !== "object" || !("providerID" in input.model) || typeof input.model.providerID !== "string" || !("id" in input.model) || typeof input.model.id !== "string") throw new Error("Invalid commit message generation request")
        const model = { providerID: input.model.providerID, id: input.model.id, ...("variant" in input.model && typeof input.model.variant === "string" ? { variant: input.model.variant } : {}) }
        return gitGenerateMessage(context.location.directory, model, (request) => context.generate.text(request)).catch((error: unknown) => call.error("operation_failed", error instanceof Error ? error.message : String(error), { message: error instanceof Error ? error.message : String(error) }))
      },
    })
    return naming.dispose
  },
})
