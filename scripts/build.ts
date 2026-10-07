import solid from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/index.ts", "src/tui.tsx"], outdir: "dist", target: "bun", format: "esm",
  packages: "external", plugins: [solid], sourcemap: "linked",
})
if (!result.success) throw new AggregateError(result.logs, "Build failed")
console.log("Built server and terminal plugins")
