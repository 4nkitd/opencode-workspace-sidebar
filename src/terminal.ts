export function editorTerminal(env: Record<string, string | undefined> = process.env) {
  return env.TERM_PROGRAM?.toLowerCase() === "vscode"
}
