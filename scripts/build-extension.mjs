// Builds the Presign browser extension into extension/dist (load it unpacked from there).
// Each entry is bundled to a self-contained classic script: content scripts cannot use modules.
//
// --dev (npm run build:extension:dev): a development build that also accepts a Presign on
// http://localhost:3000 (manifest externally_connectable + the "Local" instance). A production
// build never talks to localhost, where any other local project could be listening.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "extension");
const out = path.join(src, "dist");
const dev = process.argv.includes("--dev");
const LOCAL_PRESIGN = "http://localhost:3000/*";

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const entry of ["inject", "content", "background", "popup"]) {
  const bundle = await rolldown({ input: path.join(src, "src", `${entry}.ts`), platform: "browser", logLevel: "warn", transform: { define: { __PRESIGN_DEV__: dev ? "true" : "false" } } });
  await bundle.write({ file: path.join(out, `${entry}.js`), format: "iife", sourcemap: false });
  await bundle.close();
}

const manifest = JSON.parse(await readFile(path.join(src, "manifest.json"), "utf8"));
if (manifest.externally_connectable.matches.includes(LOCAL_PRESIGN)) throw new Error(`extension/manifest.json must not list ${LOCAL_PRESIGN}; --dev adds it`);
if (dev) manifest.externally_connectable.matches.push(LOCAL_PRESIGN);
await writeFile(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await cp(path.join(src, "popup.html"), path.join(out, "popup.html"));
await cp(path.join(src, "icons"), path.join(out, "icons"), { recursive: true });

console.log(`Presign extension built${dev ? " (development: also localhost:3000)" : ""}: ${path.relative(root, out)} (chrome://extensions → Developer mode → Load unpacked)`);
