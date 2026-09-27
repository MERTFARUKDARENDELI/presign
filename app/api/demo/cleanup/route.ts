import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { buildDemoCleanup } from "@/lib/demo/scenario";
import { cleanupActionSchema, publicKeySchema } from "@/lib/validation/schemas";

const schema = z.object({ tokenAccount: publicKeySchema, action: cleanupActionSchema });

/** Demo cleanup preview: real intent + integrity check, signing disabled. */
export const POST = withApi({ name: "demo-cleanup", limit: 60, windowMs: 60_000 }, async (request) => {
  const body = schema.parse(await readJsonBody(request, 2_000));
  const preview = buildDemoCleanup(body.tokenAccount, body.action);
  if (!preview) throw new AppError("ACCOUNT_NOT_FOUND", "Not a demo token account.");
  return ok(preview);
});
