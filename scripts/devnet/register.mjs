/**
 * Lets plain Node run TypeScript from lib/ the way Next does: resolves the
 * `@/` alias and extensionless relative imports to `.ts` files, and stubs
 * `server-only`. Used as `node --experimental-transform-types --import ./scripts/devnet/register.mjs …`.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

function withTs(path) {
  if (existsSync(path)) return path;
  if (existsSync(`${path}.ts`)) return `${path}.ts`;
  if (existsSync(`${path}/index.ts`)) return `${path}/index.ts`;
  return path;
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(withTs(root + specifier.slice(2))).href, context);
    // Only our own sources: dependencies resolve as usual (CommonJS included).
    const ours = context.parentURL?.startsWith("file:") && !context.parentURL.includes("/node_modules/");
    if (ours && specifier.startsWith(".") && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) {
      return next(pathToFileURL(withTs(fileURLToPath(new URL(specifier, context.parentURL)))).href, context);
    }
    return next(specifier, context);
  },
});
