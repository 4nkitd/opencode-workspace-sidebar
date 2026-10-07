import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { SpinnerRenderable } from "opentui-spinner"

test("native OpenCode spinner frames advance without color pulsing", async () => {
  const setup = await createTestRenderer({ width: 8, height: 2 })
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  try {
    const spinner = new SpinnerRenderable(setup.renderer, { frames, interval: 80, color: "#7bd88f" })
    setup.renderer.root.add(spinner)
    await setup.renderOnce()
    const first = setup.captureCharFrame()
    await Bun.sleep(95)
    await setup.renderOnce()
    const next = setup.captureCharFrame()
    expect(next).not.toBe(first)
    expect(spinner.color).toBe("#7bd88f")
    expect(spinner.interval).toBe(80)
    expect(frames.some((frame) => next.includes(frame))).toBe(true)
  } finally {
    setup.renderer.destroy()
  }
})
