import { AppError } from "@/lib/api/errors";
import { readJsonBody, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { explainSigningFindings } from "@/lib/presign/explain";
import { signingExplainSchema } from "@/lib/presign/schemas";
import { canonicalJson, openToken, sessionIdFrom, sha256Hex } from "@/lib/presign/tokens";
import type { SigningFindings } from "@/lib/presign/types";

export const maxDuration = 45;

/** Optional AI explanation — only of findings whose hash Presign sealed at analysis time. */
export const POST = withApi({ name: "presign-explain", limit: 8, windowMs: 60_000 }, async (request) => {
  const body = signingExplainSchema.parse(await readJsonBody(request, 64_000));
  const opened = openToken<{ fh: string; sid: string }>("findings", body.findingsToken);
  const sid = sessionIdFrom(request);
  if (!opened.ok || !sid || opened.data.sid !== sid) throw new AppError("SECURITY_BLOCK", "These findings are not from a current Presign review.", { reason: "REQUEST_INVALID" });
  if (sha256Hex(canonicalJson(body.findings)) !== opened.data.fh) throw new AppError("SECURITY_BLOCK", "The findings were modified after the review.", { reason: "FINDINGS_MISMATCH" });
  return ok(await explainSigningFindings(body.findings as unknown as SigningFindings));
});
