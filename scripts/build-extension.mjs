// Builds the Presign browser extension into extension/dist (load it unpacked from there).
// Each entry is bundled to a self-contained classic script: content scripts cannot use modules.
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "extension");
const out = path.join(src, "dist");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const entry of ["inject", "content", "background", "popup"]) {
  const bundle = await rolldown({ input: path.join(src, "src", `${entry}.ts`), platform: "browser", logLevel: "warn" });
  await bundle.write({ file: path.join(out, `${entry}.js`), format: "iife", sourcemap: false });
  await bundle.close();
}

await cp(path.join(src, "manifest.json"), path.join(out, "manifest.json"));
await cp(path.join(src, "popup.html"), path.join(out, "popup.html"));
await cp(path.join(src, "icons"), path.join(out, "icons"), { recursive: true });

console.log(`Presign extension built: ${path.relative(root, out)} (chrome://extensions → Developer mode → Load unpacked)`);
