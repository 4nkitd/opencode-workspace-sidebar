import { LayoutEvents, RenderableEvents, Yoga, type Renderable } from "@opentui/core"

export function balanceEditorPane(terminal: Renderable, version: string) {
  if (version !== "2.0.23") return
  let pane = terminal.parent
  while (pane?.parent && !pane.parent.getChildren().some((child) => child.id === "session-pane")) pane = pane.parent
  const frame = pane?.parent
  const chat = frame?.getChildren().find((child) => child.id === "session-pane")
  if (!pane || !frame || !chat || pane === chat || frame.primaryAxis !== "row") return
  const right = pane
  let root: Renderable = frame
  while (root.parent) root = root.parent
  const originalWidth = right.getLayoutNode().getWidth()
  if (originalWidth.unit !== Yoga.Unit.Point || !Number.isFinite(originalWidth.value)) return
  const handle = frame.getChildren().find((child) => {
    const node = child.getLayoutNode()
    const width = node.getWidth()
    return child !== chat && child !== right && node.getPositionType() === Yoga.PositionType.Absolute && width.unit === Yoga.Unit.Point && width.value === 2
  })
  const handleVisible = handle?.visible
  let disposed = false
  const resize = () => {
    if (disposed || frame.isDestroyed || right.isDestroyed) return
    const available = frame.getLayoutNode().getComputedWidth()
    if (available < 2) return
    const width = Math.floor(available / 2)
    if (right.getLayoutNode().getComputedWidth() !== width) right.width = width
  }
  // The native divider uses full-window coordinates, which exclude neither dock.
  // Hide its drag target while this version-scoped adapter owns the equal split.
  if (handle) handle.visible = false
  const cleanup = () => {
    if (disposed) return
    disposed = true
    root.off(LayoutEvents.LAYOUT_CHANGED, resize)
    terminal.off(RenderableEvents.DESTROYED, cleanup)
    if (!right.isDestroyed) right.width = originalWidth.value
    if (handle && !handle.isDestroyed) handle.visible = handleVisible!
  }
  root.on(LayoutEvents.LAYOUT_CHANGED, resize)
  terminal.on(RenderableEvents.DESTROYED, cleanup)
  resize()
  return cleanup
}
