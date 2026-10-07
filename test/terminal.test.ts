import { expect, test } from "bun:test"
import { editorTerminal } from "../src/terminal"

test("VS Code and VSCodium integrated terminals suppress the workspace sidebar", () => {
  expect(editorTerminal({ TERM_PROGRAM: "vscode" })).toBe(true)
  expect(editorTerminal({ TERM_PROGRAM: "VSCode", VSCODE_PID: "123" })).toBe(true)
})

test("external terminals remain enabled despite inherited editor variables", () => {
  expect(editorTerminal({ TERM_PROGRAM: "ghostty", VSCODE_PID: "123" })).toBe(false)
  expect(editorTerminal({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false)
  expect(editorTerminal({})).toBe(false)
})
