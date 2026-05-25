import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/ticktick.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/ticktick.mjs",
  platform: "node",
  target: "node20",
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
    "@earendil-works/pi-ai",
  ],
  minify: true,
});

console.log("Build complete: dist/ticktick.mjs");
