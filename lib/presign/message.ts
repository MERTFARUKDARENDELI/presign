import { VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { buildAssessment } from "@/lib/security/engine";
import type { RiskAssessment, RiskSignal } from "@/lib/security/risk";
import { scanText } from "@/lib/security/text-signals";
import type { Evidence } from "@/lib/security/types";
import { assessUrl, urlEvidenceText, worstUrlLevel } from "@/lib/security/url-reputation";
import type { PlainExplanation, TechnicalIssue } from "./types";

/**
 * Deterministic analysis of an off-chain message signing request.
 *
 * A message signature cannot move funds by itself, but it can be replayed as
 * a login, used as an off-chain authorization by the requesting service, or —
 * when the "message" is really transaction bytes — authorize a transaction.
 * Text that cannot be decoded is UNVERIFIABLE: Presign will not pretend to
 * know what it says.
 */

export const MAX_MESSAGE_BYTES = 4_096;

export interface MessageContext {
  /** Origin Presign verified for this request (connection token), or null. */
  expectedHost: string | null;
}

export interface MessageAnalysis {
  text: string | null;
  byteLength: number;
  risk: RiskAssessment;
  technicalIssues: TechnicalIssue[];
  explanation: PlainExplanation;
}

const HIDDEN = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
const SECRET_WORDS = /\b(seed phrase|secret phrase|recovery phrase|mnemonic|private key|secret key|12[- ]word|24[- ]word)\b/i;
const AUTH_WORDS = /\b(transfer|withdraw|approve|approval|authori[sz]e|delegate|spend|unlimited|all (of )?(your )?(assets|funds|tokens)|permission to move|grant access)\b/i;
const NONCE = /\b(nonce|request id|challenge)\s*[:=]/i;
const TIMESTAMP = /\b(issued( at)?|expires?( at)?|expiration( time)?|timestamp|not before)\s*[:=]/i;
const LOGIN = /\b(sign[ -]?in|log[ -]?in|wants you to sign|verify (your )?(wallet|ownership|address)|authenticat)/i;
/**
 * Long encoded runs — 100+ characters of the base64 alphabet, which also covers
 * base58, hex and base64url: signatures, keys or serialized payloads, not words.
 * (A 32-byte hex nonce or a base58 address is far shorter.)
 */
const OPAQUE = /[A-Za-z0-9+/_-]{100,}={0,2}/g;
const STATED_DOMAIN = /(?:^|\n)\s*(?:domain|uri|url|origin|website)\s*:\s*(\S+)|(?:^|\n)\s*([a-z0-9.-]+\.[a-z]{2,}(?::\d+)?) wants you to sign/i;

/** Technical issues (not risk rules): why a message cannot be verified at all. */
function issue(code: string, kind: TechnicalIssue["kind"], message: string): TechnicalIssue {
  return { code, kind, message };
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Readable text: no control characters other than tab / newline / carriage return.
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

/** Byte 0xFF followed by "solana offchain": the signing domain of Solana's off-chain message format (can never be a transaction). */
const OFFCHAIN_DOMAIN = [0xff, ...new TextEncoder().encode("solana offchain")];

/**
 * Body of a Solana off-chain message (version 0), or null. Two layouts exist:
 * solana-sdk / Ledger (format u8, length u16) and the extended one (32-byte
 * application domain, format, signer list, length). The length must match the
 * remaining bytes exactly, so arbitrary data is never misread as a body.
 */
export function offchainMessageBody(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 20 || !OFFCHAIN_DOMAIN.every((b, i) => bytes[i] === b) || bytes[16] !== 0) return null;
  const len = (at: number) => bytes[at] | (bytes[at + 1] << 8);
  // solana-sdk: [domain 16][version 1][format 1][length 2][message]
  if (bytes[17] <= 2 && len(18) === bytes.length - 20) return bytes.subarray(20);
  // extended: [domain 16][version 1][application domain 32][format 1][signer count 1][signers 32·n][length 2][message]
  if (bytes.length >= 53) {
    const signers = bytes[50];
    const at = 51 + 32 * signers;
    if (bytes[49] <= 2 && at + 2 <= bytes.length && len(at) === bytes.length - at - 2) return bytes.subarray(at + 2);
  }
  return null;
}

function looksLikeTransactionMessage(bytes: Uint8Array): boolean {
  if (bytes.length < 40) return false;
  try {
    const m = VersionedMessage.deserialize(bytes);
    return m.staticAccountKeys.length > 0 && m.header.numRequiredSignatures > 0 && m.compiledInstructions.length > 0;
  } catch {
    return false;
  }
}

function decodesAsTransaction(bytes: Uint8Array): boolean {
  if (looksLikeTransactionMessage(bytes)) return true;
  try {
    return VersionedTransaction.deserialize(bytes).message.compiledInstructions.length > 0;
  } catch {
    return false;
  }
}

/** Encoded blobs in the text, and whether any of them decodes as a Solana transaction. */
function opaqueRuns(text: string): { runs: string[]; transaction: boolean } {
  const runs = [...text.matchAll(OPAQUE)].map((m) => m[0]);
  const transaction = runs.some((r) => {
    const candidates: Array<() => Uint8Array> = [
      () => (/^(0x)?[0-9a-f]+$/i.test(r) ? Uint8Array.from(Buffer.from(r.replace(/^0x/i, ""), "hex")) : new Uint8Array()),
      () => bs58.decode(r),
      () => Uint8Array.from(Buffer.from(r, /[-_]/.test(r) ? "base64url" : "base64")),
    ];
    return candidates.some((decode) => {
      try {
        return decodesAsTransaction(decode());
      } catch {
        return false;
      }
    });
  });
  return { runs, transaction };
}

function hostOf(raw: string): string | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).host.toLowerCase();
  } catch {
    return null;
  }
}

export function analyzeMessage(bytes: Uint8Array, ctx: MessageContext, now: Date = new Date()): MessageAnalysis {
  const evidence: Evidence[] = [];
  const signals: RiskSignal[] = [];
  const issues: TechnicalIssue[] = [];
  let n = 0;
  const ev = (label: string, observed: string | boolean | null, condition?: string) => {
    const id = `msg-${++n}`;
    evidence.push({ id, source: "DETERMINISTIC_RULE", label, observed, ...(condition ? { condition } : {}) });
    return id;
  };

  if (bytes.length === 0) issues.push(issue("MESSAGE_EMPTY", "INVALID", "The message is empty."));
  if (bytes.length > MAX_MESSAGE_BYTES) issues.push(issue("MESSAGE_TOO_LARGE", "INVALID", `The message is larger than ${MAX_MESSAGE_BYTES} bytes.`));

  const offchain = offchainMessageBody(bytes);
  const isTx = !offchain && bytes.length > 0 && looksLikeTransactionMessage(bytes);
  const text = isTx ? null : decodeText(offchain ?? bytes);
  if (offchain) ev("Message format", "Solana off-chain message (v0)", "header removed; the text below is what is signed with it");

  if (isTx) {
    const id = ev("Message bytes", "decode as a Solana transaction message", "message bytes are a transaction");
    signals.push({ code: "MSG_IS_TRANSACTION", title: "This \"message\" is a transaction", description: "The bytes you would sign as a message are a valid Solana transaction message. Signing them can authorize that transaction.", severity: "CRITICAL", evidenceIds: [id] });
  } else if (text === null && bytes.length > 0 && issues.length === 0) {
    issues.push(issue("MESSAGE_NOT_TEXT", "UNVERIFIABLE", "Presign cannot decode this message into readable text, so it cannot tell what you would be signing."));
  }

  if (text !== null) {
    if (HIDDEN.test(text)) {
      const id = ev("Message text", "contains invisible characters", "zero-width or bidi characters present");
      signals.push({ code: "MSG_HIDDEN_CHARACTERS", title: "Invisible characters in the message", description: "The text contains zero-width or direction-changing characters that can hide or reorder what you read.", severity: "HIGH", evidenceIds: [id] });
    }
    const secret = SECRET_WORDS.exec(text);
    if (secret) {
      const id = ev("Message text", `mentions "${secret[0].toLowerCase()}"`, "secret material mentioned");
      signals.push({ code: "MSG_SECRET_REQUEST", title: "Mentions your seed phrase or private key", description: "No legitimate application needs your seed phrase or private key, in a message or anywhere else.", severity: "HIGH", evidenceIds: [id] });
    }
    const auth = AUTH_WORDS.exec(text);
    if (auth) {
      const id = ev("Message text", `contains "${auth[0].toLowerCase()}"`, "permission or transfer language");
      signals.push({ code: "MSG_AUTHORIZATION_LANGUAGE", title: "Permission or transfer language", description: "A message signature does not move funds by itself, but the requesting service may treat it as your authorization. Make sure you agree with exactly what it says.", severity: "MEDIUM", evidenceIds: [id] });
    }

    const stated = STATED_DOMAIN.exec(text);
    const statedHost = stated ? hostOf(stated[1] ?? stated[2] ?? "") : null;
    if (statedHost && ctx.expectedHost && statedHost !== ctx.expectedHost.toLowerCase()) {
      const id = ev("Domain stated in the message", statedHost, `differs from the verified request origin ${ctx.expectedHost}`);
      signals.push({ code: "MSG_DOMAIN_MISMATCH", title: "Message names a different website", description: "The message claims to be for another site than the one that is asking you to sign — a classic phishing pattern.", severity: "HIGH", evidenceIds: [id] });
    }

    const scan = scanText(text);
    const assessed = [...scan.urls, ...scan.domains].map(assessUrl).filter((a) => a.level !== null);
    const worst = worstUrlLevel(assessed);
    if (worst) {
      const id = ev("Links in the message", assessed.map(urlEvidenceText).join("; "), "link matches phishing patterns");
      signals.push({ code: "MSG_SUSPICIOUS_LINK", title: "Suspicious link in the message", description: `A link in the text matches phishing patterns (${worst} pattern level). Do not open it.`, severity: worst === "LOW" ? "LOW" : worst, evidenceIds: [id] });
    }
    if (scan.promptInjection) {
      const id = ev("Message text", "addresses an AI system", "prompt-injection wording");
      signals.push({ code: "MSG_PROMPT_INJECTION", title: "Text tries to instruct an AI", description: "The message contains wording aimed at manipulating automated reviewers. Presign's verdict comes from rules, not from the text.", severity: "MEDIUM", evidenceIds: [id] });
    }
    const opaque = opaqueRuns(text);
    if (opaque.runs.length > 0) {
      const sample = opaque.runs[0];
      const id = ev("Encoded data in the message", `${opaque.runs.length} block(s), e.g. ${sample.slice(0, 16)}…${sample.slice(-8)} (${sample.length} chars)${opaque.transaction ? "; decodes as a Solana transaction" : ""}`, "long unexplained encoded data");
      signals.push({ code: "MSG_OPAQUE_DATA", title: opaque.transaction ? "Message contains an encoded transaction" : "Message contains data you cannot read", description: opaque.transaction ? "Part of the text is a Solana transaction in encoded form. Your message signature does not execute it, but the service may present your signature as agreement to it. Ask what it is before signing." : "Part of the text is a long encoded block (a key, signature or payload). You would be signing something you cannot read; the service could later claim it means more than the visible words.", severity: "MEDIUM", evidenceIds: [id] });
    }
    if (LOGIN.test(text) && !(NONCE.test(text) && TIMESTAMP.test(text))) {
      const id = ev("Login message", "no nonce or no timestamp", "replayable sign-in");
      signals.push({ code: "MSG_REPLAYABLE_LOGIN", title: "Sign-in message without nonce or expiry", description: "Without a one-time nonce and a timestamp, this signature could be reused to log in as you later.", severity: "LOW", evidenceIds: [id] });
    }
  }

  const status = isTx || text !== null ? "COMPLETE" : "INSUFFICIENT_DATA";
  const risk = buildAssessment({
    category: "message",
    signals,
    evidence,
    sources: [{ source: "DETERMINISTIC_RULE", status: status === "COMPLETE" ? "OK" : "FAILED", detail: isTx ? "message bytes decode as a transaction" : text !== null ? `${bytes.length} bytes of text` : "not decodable as text" }],
    status,
    now,
  });

  const whatHappens = isTx
    ? ["Your wallet would sign raw transaction bytes presented as a message. This can authorize the transaction they encode."]
    : text !== null
      ? ["Your wallet signs the text shown below. A message signature does not send a transaction or move funds by itself.", "The requesting service can keep the signature and present it later as proof that you agreed to this exact text."]
      : ["Presign cannot decode what these bytes say."];

  return {
    text,
    byteLength: bytes.length,
    risk,
    technicalIssues: issues,
    explanation: {
      headline: isTx ? "A transaction disguised as a message" : text !== null ? "Sign a text message" : "Undecodable message",
      whatHappens,
      assetMovements: [],
      programs: [],
      accountChanges: [],
      whyRisky: risk.signals.map((s) => `${s.severity}: ${s.title} — ${s.description}`),
      simulation: "Not applicable: a message is not executed on-chain.",
      completeness: status === "COMPLETE" ? "The full message was decoded." : "The message could not be decoded.",
    },
  };
}
