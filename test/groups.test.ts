import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Project } from "@opencode/client"
import {
  defaultGroupsPath, groupProjects, MAX_DIRECTORIES_PER_GROUP, MAX_GROUPS, parseGroups, readProjectGroups,
  type Group,
} from "../src/groups"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "workspace-sidebar-groups-"))
  roots.push(root)
  return root
}
const project = (id: string, canonical: string, name?: string): Project =>
  ({ id, canonical, name, time: { created: 0, updated: 0, active: 0 }, sandboxes: [] })

test("expands home, normalises paths, trims names and preserves declared order", () => {
  const home = "/Users/tester"
  const groups = parseGroups({ groups: [
    { name: "  Services  ", directories: ["~/projects/services/api", "/opt/x//y/", "~/"] },
    { name: "Other", directories: ["/srv/../srv/app"] },
  ] }, home)
  expect(groups).toEqual([
    { name: "Services", directories: ["/Users/tester/projects/services/api", "/opt/x/y", "/Users/tester"] },
    { name: "Other", directories: ["/srv/app"] },
  ])
})

test("treats an absent groups key as an empty configuration", () => {
  expect(parseGroups({}, "/home/u")).toEqual([])
})

test("rejects malformed shapes with actionable messages", () => {
  expect(() => parseGroups(null, "/home/u")).toThrow(/expected a JSON object/)
  expect(() => parseGroups([], "/home/u")).toThrow(/expected a JSON object/)
  expect(() => parseGroups({ groups: {} }, "/home/u")).toThrow(/"groups" must be an array/)
  expect(() => parseGroups({ groups: [{ name: "a" }] }, "/home/u")).toThrow(/directories must be an array/)
  expect(() => parseGroups({ groups: [{ name: 1, directories: [] }] }, "/home/u")).toThrow(/name must be a string/)
  expect(() => parseGroups({ groups: [{ name: " ", directories: [] }] }, "/home/u")).toThrow(/name must not be empty/)
  expect(() => parseGroups({ groups: [{ name: "a", directories: [1] }] }, "/home/u")).toThrow(/must be a string/)
})

test("rejects unknown fields instead of silently ignoring typos", () => {
  expect(() => parseGroups({ groupz: [] }, "/home/u")).toThrow(/unknown key "groupz"/)
  expect(() => parseGroups({ groups: [{ name: "a", directories: [], colour: "red" }] }, "/home/u")).toThrow(/unknown key "colour"/)
})

test("rejects relative, empty and unsupported home paths", () => {
  expect(() => parseGroups({ groups: [{ name: "a", directories: ["relative/path"] }] }, "/home/u")).toThrow(/absolute path/)
  expect(() => parseGroups({ groups: [{ name: "a", directories: ["  "] }] }, "/home/u")).toThrow(/must not be empty/)
  expect(() => parseGroups({ groups: [{ name: "a", directories: ["~root/x"] }] }, "/home/u")).toThrow(/unsupported expansion/)
})

test("rejects duplicate group names and duplicate directory memberships", () => {
  expect(() => parseGroups({ groups: [{ name: "a", directories: [] }, { name: "a", directories: [] }] }, "/home/u")).toThrow(/duplicate group name/)
  expect(() => parseGroups({ groups: [{ name: "a", directories: ["/x", "/x"] }] }, "/home/u")).toThrow(/duplicate directory/)
  expect(() => parseGroups({ groups: [{ name: "a", directories: ["/x"] }, { name: "b", directories: ["/x/"] }] }, "/home/u")).toThrow(/duplicate directory/)
})

test("bounds the number of groups and directories", () => {
  const many = Array.from({ length: MAX_GROUPS + 1 }, (_, index) => ({ name: `g${index}`, directories: [] }))
  expect(() => parseGroups({ groups: many }, "/home/u")).toThrow(/too many groups/)
  const wide = Array.from({ length: MAX_DIRECTORIES_PER_GROUP + 1 }, (_, index) => `/p/${index}`)
  expect(() => parseGroups({ groups: [{ name: "a", directories: wide }] }, "/home/u")).toThrow(/too many directories/)
  const full = Array.from({ length: MAX_GROUPS }, (_, index) => ({ name: `g${index}`, directories: [] }))
  expect(parseGroups({ groups: full }, "/home/u")).toHaveLength(MAX_GROUPS)
})

test("builds the config path from XDG_CONFIG_HOME or the home fallback", () => {
  expect(defaultGroupsPath("/Users/tester", { XDG_CONFIG_HOME: "/tmp/xdg" })).toBe("/tmp/xdg/opencode/workspace-sidebar.json")
  expect(defaultGroupsPath("/Users/tester", { XDG_CONFIG_HOME: "relative" })).toBe("/Users/tester/.config/opencode/workspace-sidebar.json")
  expect(defaultGroupsPath("/Users/tester", {})).toBe("/Users/tester/.config/opencode/workspace-sidebar.json")
})

test("missing config files load as an empty group list without an error", async () => {
  const root = await temp()
  expect(await readProjectGroups({ configPath: join(root, "absent.json"), home: root })).toEqual({ groups: [] })
})

test("invalid config files return a visible error instead of throwing", async () => {
  const root = await temp()
  const configPath = join(root, "workspace-sidebar.json")
  await Bun.write(configPath, "{ not json")
  const broken = await readProjectGroups({ configPath, home: root })
  expect(broken.groups).toEqual([])
  expect(broken.error).toContain("Invalid project groups config")
  await Bun.write(configPath, JSON.stringify({ groups: [{ name: "a", directories: ["relative"] }] }))
  const invalid = await readProjectGroups({ configPath, home: root })
  expect(invalid.groups).toEqual([])
  expect(invalid.error).toContain("absolute path")
})

test("valid config files load groups with home expanded", async () => {
  const root = await temp()
  const configPath = join(root, "workspace-sidebar.json")
  await Bun.write(configPath, JSON.stringify({ groups: [{ name: "Services", directories: ["~/projects/services/api"] }] }))
  expect(await readProjectGroups({ configPath, home: root })).toEqual({
    groups: [{ name: "Services", directories: [join(root, "projects/services/api")] }],
  })
})

test("groups known projects, keeps native project order and reports unresolved configured paths", () => {
  const groups: Group[] = [{ name: "Services", directories: ["/repo/b", "/repo/a", "/repo/missing"] }]
  const result = groupProjects([project("1", "/repo/c"), project("2", "/repo/b"), project("3", "/repo/a")], groups, "")
  expect(result.groups).toEqual([{ name: "Services", projects: [
    project("2", "/repo/b"), project("3", "/repo/a"),
  ], directories: ["/repo/missing"] }])
  expect(result.ungrouped).toEqual([project("1", "/repo/c")])
})

test("excludes the root sentinel and duplicate project directories", () => {
  const result = groupProjects([project("0", "/"), project("1", "/repo/a"), project("2", "/repo/a")], [], "")
  expect(result.groups).toEqual([])
  expect(result.ungrouped).toHaveLength(1)
})

test("matches groups by name, keeping all of their members for auto-expansion", () => {
  const groups: Group[] = [{ name: "Services", directories: ["/repo/a"] }, { name: "Other", directories: ["/repo/b"] }]
  const result = groupProjects([project("1", "/repo/a", "demo"), project("2", "/repo/b", "worker")], groups, "serv")
  expect(result.groups).toEqual([
    { name: "Services", projects: [project("1", "/repo/a", "demo")], directories: [] },
  ])
})

test("matches groups by child name or path, keeping only matching children", () => {
  const groups: Group[] = [{ name: "Services", directories: ["/repo/a", "/repo/missing"] }]
  const result = groupProjects([project("1", "/repo/a", "alpha"), project("2", "/repo/b", "beta")], groups, "missing")
  expect(result.groups).toEqual([{ name: "Services", projects: [], directories: ["/repo/missing"] }])
  const named = groupProjects([project("1", "/repo/a", "alpha")], groups, "alpha")
  expect(named.groups).toEqual([{ name: "Services", projects: [project("1", "/repo/a", "alpha")], directories: [] }])
})

test("filters ungrouped projects and drops groups with no matches", () => {
  const groups: Group[] = [{ name: "Services", directories: ["/repo/a"] }]
  const result = groupProjects([project("1", "/repo/a", "alpha"), project("2", "/repo/b", "beta")], groups, "beta")
  expect(result.groups).toEqual([])
  expect(result.ungrouped).toEqual([project("2", "/repo/b", "beta")])
})
