import { z } from "zod";
import { walletAddressSchema } from "@/lib/validation/schemas";
import { DEMO_SCENARIOS } from "./demo-scenarios";
import { MAX_PAYLOAD_CHARS } from "./payload";

const token = z.string().min(20).max(8_000);

export const connectRequestSchema = z.object({
  target: z.string().max(2_048).optional(),
  name: z.string().max(200).optional(),
  returnUrl: z.string().max(2_048).optional(),
  walletType: z.string().max(64).optional(),
});

export const ownershipNonceSchema = z.object({ walletAddress: walletAddressSchema });

export const ownershipVerifySchema = z.object({
  walletAddress: walletAddressSchema,
  message: z.string().min(1).max(2_000),
  signature: z.string().min(64).max(200),
  nonceToken: token,
});

export const signingAnalyzeSchema = z.object({
  type: z.enum(["MESSAGE", "TRANSACTION"]),
  payload: z.string().min(1).max(MAX_PAYLOAD_CHARS),
  payloadEncoding: z.enum(["base58", "base64", "utf8"]).optional(),
  walletAddress: walletAddressSchema,
  application: z.string().max(200).optional(),
  domain: z.string().max(2_048).optional(),
  connectionToken: token.optional(),
  expectedEffects: z
    .object({
      summary: z.string().max(300).optional(),
      maxSolOutLamports: z.string().regex(/^\d{1,20}$/).optional(),
      maxTokenOut: z.array(z.object({ mint: walletAddressSchema, amountRaw: z.string().regex(/^\d{1,20}$/) })).max(20).optional(),
    })
    .optional(),
});

export const signingApproveSchema = z.object({
  analysisToken: token,
  payload: z.string().min(1).max(MAX_PAYLOAD_CHARS),
  payloadEncoding: z.enum(["base58", "base64", "utf8"]).optional(),
  walletAddress: walletAddressSchema,
  choice: z.enum(["SIGN", "CONTINUE", "OVERRIDE"]),
  overrideConfirmed: z.boolean().optional(),
  riskLevel: z.string().max(16).optional(),
  targetOrigin: z.string().max(2_048).nullable().optional(),
});

export const signingExplainSchema = z.object({
  findingsToken: token,
  findings: z.record(z.string(), z.unknown()),
});

export const demoRequestSchema = z.object({
  scenario: z.enum(DEMO_SCENARIOS),
  walletAddress: walletAddressSchema,
});
