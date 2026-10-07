import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { defaultGroupsPath } from "./groups"

export const cliConfigPath = () => join(dirname(defaultGroupsPath()), "cli.json")

export async function animationsEnabled() {
  const config: unknown = await readFile(cliConfigPath(), "utf8").then(JSON.parse).catch(() => undefined)
  const inline: unknown = process.env.OPENCODE_CLI_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CLI_CONFIG_CONTENT) : undefined
  if (inline && typeof inline === "object" && "animations" in inline && typeof inline.animations === "boolean") return inline.animations
  if (config && typeof config === "object" && "animations" in config && typeof config.animations === "boolean") return config.animations
  return true
}
