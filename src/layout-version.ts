export function supportsOpenCodeLayout(version: string) {
  const match = /^2\.0\.(\d+)(?:[-+].*)?$/.exec(version)
  return match !== null && Number(match[1]) >= 23
}
