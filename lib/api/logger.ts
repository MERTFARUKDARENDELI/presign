/**
 * Structured, redacting logger. Never logs secrets, keys, seed phrases or
 * full provider URLs. Wallet addresses should be passed through maskAddress().
 */

type Level = "debug" | "info" | "warn" | "error";

const SENSITIVE_KEY = /(api[-_]?key|secret|private[-_]?key|seed|mnemonic|password|authorization|access[-_]?token|bearer)/i;
const SECRET_IN_STRING = /(api[-_]?key=)[^&\s"']+/gi;
const BEARER_IN_STRING = /(bearer\s+)[a-z0-9._-]+/gi;
// Provider-style secret keys, including partially masked echoes in upstream error messages.
const KEY_LIKE = /(?<![A-Za-z0-9])(sk|pk|rk)-[A-Za-z0-9_*-]{4,}/g;

export function maskAddress(address: string | null | undefined): string {
  if (!address) return "";
  return address.length <= 10 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function redactString(value: string): string {
  return value.replace(SECRET_IN_STRING, "$1[REDACTED]").replace(BEARER_IN_STRING, "$1[REDACTED]").replace(KEY_LIKE, "$1-[REDACTED]");
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: Level, event: string, fields?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
