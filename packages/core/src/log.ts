import pino, { type Logger } from "pino";

/**
 * Strip credentials from a URL: userinfo, query string and any long path segment that
 * looks like an API key (many RPC providers embed the key in the path).
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname
      .split("/")
      .map((seg) => (seg.length >= 16 && /^[A-Za-z0-9_-]+$/.test(seg) ? "***" : seg))
      .join("/");
    const auth = u.username || u.password ? "***@" : "";
    return `${u.protocol}//${auth}${u.host}${path}${u.search ? "?***" : ""}`;
  } catch {
    return "***";
  }
}

/** Keys whose string values are always fully hidden. */
const SECRET_FIELD = /(apikey|api_key|secret|password|passwd|mnemonic|seed|privatekey|private_key)/i;

/** Deep-redact an arbitrary object before logging it. URLs keep only scheme + host. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (typeof value === "string") {
    return /^(https?|wss?|postgres(ql)?):\/\//i.test(value) ? redactUrl(value) : value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_FIELD.test(k) && typeof v === "string" ? "***" : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    name,
    level,
    // Last line of defence; callers should still log redacted values only.
    redact: {
      paths: ["*.privateKey", "*.secret", "*.password", "*.apiKey", "*.rpcUrl", "*.databaseUrl", "secrets"],
      censor: "***",
    },
    formatters: {
      log: (obj) => redactSecrets(obj) as Record<string, unknown>,
    },
  });
}
