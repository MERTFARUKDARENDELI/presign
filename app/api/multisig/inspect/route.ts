import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { inspect } from "@/lib/multisig/inspect";
import { multisigInspectSchema } from "@/lib/validation/schemas";

export const maxDuration = 60;

/** Inspect a Squads proposal (what it would do) or a multisig (setup risks + recent proposals). Read-only. */
export const POST = withApi({ name: "multisig-inspect", limit: 20, windowMs: 60_000 }, async (request) => {
  const body = multisigInspectSchema.parse(await readJsonBody(request, 4_000));
  return ok(await inspect(body.input, body.signer ?? null));
});
