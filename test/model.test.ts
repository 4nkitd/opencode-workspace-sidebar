import { expect, test } from "bun:test"
import type { SessionInfo } from "@opencode/client"
import { clean, fileIcon, recentSessions, sortedFiles, projectsForSearch, statusTone } from "../src/model"
import { groupProjects } from "../src/groups"

test("tree sorts directories first without exposing git internals", () => {
  expect(sortedFiles([{ type: "file", path: "z" }, { type: "directory", path: "src" }, { type: "directory", path: ".git" }])).toEqual([
    { type: "directory", path: "src" }, { type: "file", path: "z" },
  ])
})

test("strips terminal control characters but keeps lines", () => {
  expect(clean("a\x1b[31mb\n")).toBe("a�[31mb\n")
})

test("deduplicates project canonical directories", () => {
  const project = { id: "one", canonical: "/a", time: { created: 0, updated: 0, active: 0 }, sandboxes: [] }
  expect(projectsForSearch([project, { ...project, id: "two" }], "a")).toHaveLength(1)
})

test("private projects stay hidden from the listing and searches without changing project data", () => {
  const projects = ["/private", "/private/", "/private/tmp/retained-history", "/Users/boss/project", "/privateer/project"].map((canonical, index) => ({
    id: String(index), canonical, time: { created: 0, updated: 0, active: 0 }, sandboxes: [],
  }))
  expect(projectsForSearch(projects, "").map((project) => project.canonical)).toEqual(["/Users/boss/project", "/privateer/project"])
  expect(projectsForSearch(projects, "retained-history")).toEqual([])
  expect(projectsForSearch(projects, "/private").map((project) => project.canonical)).toEqual(["/privateer/project"])
  expect(projects).toHaveLength(5)
  expect(projects[2].canonical).toBe("/private/tmp/retained-history")
})

test("hidden sessions stay out of the default list but remain searchable", () => {
  const sessions = [
    { id: "hidden", title: "Hidden session", location: { directory: "/hidden" }, time: { updated: 3 } },
    { id: "shown", title: "Shown session", location: { directory: "/shown" }, time: { updated: 2 } },
  ] as unknown as SessionInfo[]
  expect(recentSessions(sessions, [], "", [], ["hidden"]).map((session) => session.id)).toEqual(["shown"])
  expect(recentSessions(sessions, [], "hidden", [], ["hidden"]).map((session) => session.id)).toEqual(["hidden"])
})

test("hidden projects stay out of the default list but remain searchable", () => {
  const projects = [
    { id: "hidden", name: "Hidden project", canonical: "/hidden", time: { created: 0, updated: 0, active: 0 }, sandboxes: [] },
    { id: "shown", name: "Shown project", canonical: "/shown", time: { created: 0, updated: 0, active: 0 }, sandboxes: [] },
  ]
  expect(groupProjects(projects, [], "", ["/hidden"]).ungrouped.map((project) => project.id)).toEqual(["shown"])
  expect(groupProjects(projects, [], "hidden", ["/hidden"]).ungrouped.map((project) => project.id)).toEqual(["hidden"])
})

test("pinned projects stay out of the general list", () => {
  const projects = [
    { id: "pinned", name: "Pinned project", canonical: "/pinned", time: { created: 0, updated: 0, active: 0 }, sandboxes: [] },
    { id: "shown", name: "Shown project", canonical: "/shown", time: { created: 0, updated: 0, active: 0 }, sandboxes: [] },
  ]
  expect(groupProjects(projects, [], "", [], ["/pinned"]).ungrouped.map((project) => project.id)).toEqual(["shown"])
  expect(groupProjects(projects, [], "pinned", [], ["/pinned"]).ungrouped).toEqual([])
})

test("file icons identify extensions and open folders", () => {
  expect(fileIcon("src/main.ts", false)).toEqual({ glyph: "\ue628", tone: "blue" })
  expect(fileIcon("button.tsx", false).tone).toBe("teal")
  expect(fileIcon("package.json", false).tone).toBe("yellow")
  expect(fileIcon("src/", true, true).glyph).not.toBe(fileIcon("src/", true).glyph)
  expect(fileIcon("unknown.data", false).glyph).toBe("\uf15b")
})

test("Git status colors distinguish modified, added, renamed and deleted", () => {
  expect(statusTone("M")).toBe("yellow")
  expect(statusTone("A")).toBe("green")
  expect(statusTone("?")).toBe("green")
  expect(statusTone("R")).toBe("blue")
  expect(statusTone("D")).toBe("red")
  expect(statusTone("U")).toBe("red")
})
