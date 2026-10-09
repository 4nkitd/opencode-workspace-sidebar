import { describe, expect, test } from "bun:test"
import { supportsOpenCodeLayout } from "../src/layout-version"

describe("OpenCode layout compatibility", () => {
  test("supports 2.0.23 and later 2.0 releases", () => {
    expect(supportsOpenCodeLayout("2.0.23")).toBe(true)
    expect(supportsOpenCodeLayout("2.0.26")).toBe(true)
    expect(supportsOpenCodeLayout("2.0.100")).toBe(true)
  })

  test("rejects older, different-major and different-minor releases", () => {
    expect(supportsOpenCodeLayout("2.0.22")).toBe(false)
    expect(supportsOpenCodeLayout("2.1.0")).toBe(false)
    expect(supportsOpenCodeLayout("3.0.23")).toBe(false)
    expect(supportsOpenCodeLayout("development")).toBe(false)
  })
})
