import { build } from "esbuild";

await build({
  entryPoints: ["src/offscreen.js"],
  outfile: "offscreen.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  sourcemap: false,
  minify: false
});
