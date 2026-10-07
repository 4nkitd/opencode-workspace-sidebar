import type { FileSystemEntry, SessionInfo, Project } from "@opencode/client"

export const tabs = ["projects", "files", "git"] as const
export type Tab = typeof tabs[number]
export const labels = { projects: "Projects & Sessions", files: "Files", git: "Source Control" }
export type Tone = "blue" | "yellow" | "purple" | "green" | "orange" | "red" | "teal" | "muted"

export const tabIcons = {
  projects: { glyph: "\uf07c", tone: "purple" as Tone },
  files: { glyph: "\uf15b", tone: "blue" as Tone },
  git: { glyph: "\ue702", tone: "orange" as Tone },
}

export function fileIcon(path: string, directory: boolean, expanded = false): { glyph: string; tone: Tone } {
  if (directory) return { glyph: expanded ? "\uf07c" : "\uf07b", tone: "blue" }
  const name = basename(path).toLowerCase()
  if (name === "dockerfile" || name.startsWith("docker-compose")) return { glyph: "\ue7b0", tone: "blue" }
  if (name === ".gitignore" || name === ".gitattributes") return { glyph: "\ue702", tone: "orange" }
  const extension = name.split(".").pop()
  if (extension === "ts") return { glyph: "\ue628", tone: "blue" }
  if (extension === "tsx" || extension === "jsx") return { glyph: "\ue625", tone: "teal" }
  if (extension === "js" || extension === "mjs" || extension === "cjs") return { glyph: "\ue60c", tone: "yellow" }
  if (extension === "json" || extension === "jsonc") return { glyph: "\ue60b", tone: "yellow" }
  if (extension === "md" || extension === "mdx") return { glyph: "\ue609", tone: "blue" }
  if (extension === "py") return { glyph: "\ue606", tone: "yellow" }
  if (extension === "go") return { glyph: "\ue627", tone: "teal" }
  if (extension === "rs") return { glyph: "\ue7a8", tone: "orange" }
  if (extension === "html") return { glyph: "\ue60e", tone: "orange" }
  if (extension === "css" || extension === "scss") return { glyph: "\ue614", tone: "purple" }
  if (extension === "sh" || extension === "zsh") return { glyph: "\ue691", tone: "green" }
  if (["png", "jpg", "jpeg", "webp", "svg"].includes(extension ?? "")) return { glyph: "\uf03e", tone: "purple" }
  return { glyph: "\uf15b", tone: "muted" }
}

export function statusTone(status: string): Tone {
  if (status === "D" || status === "U") return "red"
  if (status === "M") return "yellow"
  if (status === "R" || status === "C") return "blue"
  return "green"
}

export function clean(text: string) {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "�")
}

export function basename(path: string) {
  return path.replace(/\/$/, "").split("/").pop() || path
}

export function sortedFiles(entries: readonly FileSystemEntry[]) {
  return entries.filter((entry) => basename(entry.path) !== ".git").toSorted((a, b) =>
    a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1,
  )
}

export function recentSessions(loaded: readonly SessionInfo[], fetched: readonly SessionInfo[], query: string, open: readonly string[]) {
  const seen = new Set<string>()
  const value = query.trim().toLowerCase()
  const pool = [...loaded, ...fetched].filter((session) => {
    if (session.parentID || seen.has(session.id)) return false
    seen.add(session.id)
    return true
  }).toSorted((a, b) => b.time.updated - a.time.updated)
  if (value) return pool.filter((item) => `${item.title} ${item.id} ${item.location.directory}`.toLowerCase().includes(value))
  return pool.filter((item) => !open.includes(item.id)).slice(0, 8)
}

export function projectsForSearch(projects: readonly Project[], query: string) {
  const seen = new Set<string>()
  const value = query.trim().toLowerCase()
  return projects.filter((project) => {
    if (project.canonical === "/" || project.canonical === "/private" || project.canonical.startsWith("/private/") || seen.has(project.canonical)) return false
    seen.add(project.canonical)
    return `${project.name ?? ""} ${project.canonical}`.toLowerCase().includes(value)
  })
}
