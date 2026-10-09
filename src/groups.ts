import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, normalize } from "node:path"
import type { Project } from "@opencode/client"
import { projectsForSearch } from "./model"

export type Group = { name: string; directories: string[] }

export type GroupMembers = { name: string; projects: Project[]; directories: string[] }
export type GroupedProjects = { groups: GroupMembers[]; ungrouped: Project[] }

export type LoadedGroups = { groups: Group[]; error?: string }

export const MAX_GROUPS = 64
export const MAX_DIRECTORIES_PER_GROUP = 256
export const MAX_GROUP_NAME_LENGTH = 120
export const MAX_DIRECTORY_LENGTH = 4096

const CONFIG_FILE = "workspace-sidebar.json"

function fail(message: string): never {
  throw new Error(`Invalid project groups config: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return `a ${typeof value}`
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key))
}

function normalizeDirectory(value: string, home: string, label: string): string {
  if (!value.trim()) fail(`${label} must not be empty`)
  if (value.includes("\0")) fail(`${label} must not contain null characters`)
  let path = value
  if (path === "~") path = home
  else if (path.startsWith("~/")) path = join(home, path.slice(2))
  else if (path.startsWith("~")) fail(`${label} uses unsupported expansion ${quote(value)}; only "~" and "~/" are recognised`)
  if (!path.startsWith("/")) fail(`${label} must be an absolute path or start with "~/", received ${quote(value)}`)
  if (path.length > MAX_DIRECTORY_LENGTH) fail(`${label} is too long (${path.length} > ${MAX_DIRECTORY_LENGTH})`)
  const normalized = normalize(path)
  if (!normalized.startsWith("/")) fail(`${label} does not resolve to an absolute path: ${quote(value)}`)
  return normalized.replace(/\/+$/, "") || "/"
}

export function parseGroups(input: unknown, home: string): Group[] {
  if (!isRecord(input)) fail(`expected a JSON object with a "groups" array, received ${describe(input)}`)
  const extra = unknownKeys(input, ["groups"])
  if (extra.length) fail(`unknown key ${extra.map(quote).join(", ")}; expected only "groups"`)
  if (input.groups === undefined) return []
  if (!Array.isArray(input.groups)) fail(`"groups" must be an array, received ${describe(input.groups)}`)
  if (input.groups.length > MAX_GROUPS) fail(`too many groups: ${input.groups.length} exceeds the limit of ${MAX_GROUPS}`)

  const groups: Group[] = []
  const names = new Set<string>()
  const directories = new Set<string>()
  input.groups.forEach((entry, index) => {
    const label = `groups[${index}]`
    if (!isRecord(entry)) fail(`${label} must be an object with "name" and "directories", received ${describe(entry)}`)
    const extraGroup = unknownKeys(entry, ["name", "directories"])
    if (extraGroup.length) fail(`${label} has unknown key ${extraGroup.map(quote).join(", ")}; expected only "name" and "directories"`)
    const name = entry.name
    if (typeof name !== "string") fail(`${label}.name must be a string, received ${describe(name)}`)
    const trimmed = name.trim()
    if (!trimmed) fail(`${label}.name must not be empty`)
    if (trimmed.length > MAX_GROUP_NAME_LENGTH) fail(`${label}.name is too long (${trimmed.length} > ${MAX_GROUP_NAME_LENGTH})`)
    if (names.has(trimmed)) fail(`duplicate group name ${quote(trimmed)}`)
    names.add(trimmed)
    const list = entry.directories
    if (!Array.isArray(list)) fail(`${label}.directories must be an array, received ${describe(list)}`)
    if (list.length > MAX_DIRECTORIES_PER_GROUP) fail(`${label} has too many directories: ${list.length} exceeds the limit of ${MAX_DIRECTORIES_PER_GROUP}`)
    const resolved: string[] = []
    list.forEach((value, position) => {
      if (typeof value !== "string") fail(`${label}.directories[${position}] must be a string, received ${describe(value)}`)
      const path = normalizeDirectory(value, home, `${label}.directories[${position}]`)
      if (directories.has(path)) fail(`duplicate directory ${quote(path)}; a directory may belong to only one group`)
      directories.add(path)
      resolved.push(path)
    })
    groups.push({ name: trimmed, directories: resolved })
  })
  return groups
}

export function defaultGroupsPath(home: string = homedir(), env: Record<string, string | undefined> = process.env): string {
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg && xdg.startsWith("/") ? xdg : join(home, ".config")
  return join(base, "opencode", CONFIG_FILE)
}

export async function readProjectGroups(options: { configPath?: string; home?: string } = {}): Promise<LoadedGroups> {
  const home = options.home ?? homedir()
  const configPath = options.configPath ?? defaultGroupsPath(home)
  let text: string
  try {
    text = await readFile(configPath, "utf8")
    if (Buffer.byteLength(text, "utf8") > 1024 * 1024) return { groups: [], error: "Project groups config exceeds 1 MiB" }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { groups: [] }
    return { groups: [], error: `Could not read project groups config at ${configPath}: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    return { groups: parseGroups(JSON.parse(text), home) }
  } catch (error) {
    return { groups: [], error: `Invalid project groups config at ${configPath}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function groupProjects(projects: readonly Project[], groups: readonly Group[], query: string, hidden: readonly string[] = [], pinned: readonly string[] = []): GroupedProjects {
  const membership = new Map<string, number>()
  const hiddenSet = new Set(hidden)
  const pinnedSet = new Set(pinned)
  groups.forEach((group, index) => group.directories.forEach((directory) => membership.set(directory, index)))

  const grouped: Project[][] = groups.map(() => [])
  const ungrouped: Project[] = []
  const matched = new Set<string>()
  const seen = new Set<string>()
  for (const project of projectsForSearch(projects, "")) {
    const canonical = normalize(project.canonical)
    if (canonical === "/" || seen.has(canonical)) continue
    seen.add(canonical)
    const index = membership.get(canonical)
    if (index === undefined) ungrouped.push(project)
    else { grouped[index].push(project); matched.add(canonical) }
  }

  const value = query.trim().toLowerCase()
  const haystack = (project: Project) => `${project.name ?? ""} ${project.canonical}`.toLowerCase()
  const result: GroupedProjects = { groups: [], ungrouped: [] }
  groups.forEach((group, index) => {
    const declared: GroupMembers = {
      name: group.name,
      projects: grouped[index].filter((project) => !pinnedSet.has(normalize(project.canonical)) && (value || !hiddenSet.has(normalize(project.canonical)))),
      directories: group.directories.filter((directory) => !pinnedSet.has(directory) && (value || !hiddenSet.has(directory)) && !matched.has(directory) && directory !== "/private" && !directory.startsWith("/private/")),
    }
    if (!value || group.name.toLowerCase().includes(value)) { result.groups.push(declared); return }
    const matchingProjects = declared.projects.filter((project) => haystack(project).includes(value))
    const matchingDirectories = declared.directories.filter((directory) => directory.toLowerCase().includes(value))
    if (matchingProjects.length || matchingDirectories.length) result.groups.push({ name: group.name, projects: matchingProjects, directories: matchingDirectories })
  })
  result.ungrouped.push(...(value ? ungrouped.filter((project) => haystack(project).includes(value) && !pinnedSet.has(normalize(project.canonical))) : ungrouped.filter((project) => !hiddenSet.has(normalize(project.canonical)) && !pinnedSet.has(normalize(project.canonical)))))
  return result
}
