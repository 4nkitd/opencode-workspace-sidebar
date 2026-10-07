import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { balanceEditorPane } from "../src/editor-layout"

test("file pane shares the available frame equally and restores native sizing", async () => {
  const setup = await createTestRenderer({ width: 180, height: 30 })
  const frame = new BoxRenderable(setup.renderer, { width: 138, height: 30, flexDirection: "row" })
  const chat = new BoxRenderable(setup.renderer, { id: "session-pane", flexGrow: 1, flexBasis: 0, minWidth: 0 })
  const pane = new BoxRenderable(setup.renderer, { width: 42, flexShrink: 0 })
  const handle = new BoxRenderable(setup.renderer, { position: "absolute", left: 95, width: 2, height: "100%" })
  const terminal = new BoxRenderable(setup.renderer, { width: "100%" })
  setup.renderer.root.add(frame)
  frame.add(chat)
  frame.add(pane)
  frame.add(handle)
  pane.add(terminal)
  const draw = async () => { await setup.renderOnce(); await setup.renderOnce() }
  let cleanup: (() => void) | undefined
  try {
    await draw()
    expect(balanceEditorPane(terminal, "unsupported")).toBeUndefined()
    cleanup = balanceEditorPane(terminal, "2.0.23")
    await draw()
    expect(chat.width).toBe(69)
    expect(pane.width).toBe(69)
    expect(handle.visible).toBe(false)
    frame.width = 101
    await draw()
    expect(Math.abs(chat.width - pane.width)).toBeLessThanOrEqual(1)
    frame.width = 58
    await draw()
    expect(chat.width).toBe(29)
    expect(pane.width).toBe(29)
    terminal.destroy()
    await draw()
    expect(pane.width).toBe(42)
    expect(handle.visible).toBe(true)
  } finally { cleanup?.(); setup.renderer.destroy() }
})

test("initialization before the first layout preserves declared widths and divider", async () => {
  const setup = await createTestRenderer({ width: 138, height: 30 })
  const frame = new BoxRenderable(setup.renderer, { flexDirection: "row", width: "100%", height: "100%" })
  const chat = new BoxRenderable(setup.renderer, { id: "session-pane", flexGrow: 1, flexBasis: 0, minWidth: 0 })
  const pane = new BoxRenderable(setup.renderer, { flexShrink: 0 })
  const handle = new BoxRenderable(setup.renderer, { position: "absolute", height: "100%" })
  const terminal = new BoxRenderable(setup.renderer, {})
  pane.width = 42
  handle.width = 2
  setup.renderer.root.add(frame)
  frame.add(chat)
  frame.add(pane)
  frame.add(handle)
  pane.add(terminal)
  const cleanup = balanceEditorPane(terminal, "2.0.23")
  try {
    expect(cleanup).toBeDefined()
    await setup.renderOnce()
    await setup.renderOnce()
    expect(chat.width).toBe(69)
    expect(pane.width).toBe(69)
    expect(handle.visible).toBe(false)
    cleanup?.()
    await setup.renderOnce()
    expect(pane.width).toBe(42)
    expect(handle.visible).toBe(true)
  } finally { cleanup?.(); setup.renderer.destroy() }
})
