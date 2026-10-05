import type { Tool } from "./types.ts";

export const MAX_BODY_BYTES = 64 * 1024;
export const REDACTED = "REDACTED";

const SENSITIVE = new Set(
  [
    "password",
    "passwd",
    "secret",
    "api_key",
    "apikey",
    "auth",
    "credentials",
    "mysql_pwd",
    "privatekey",
    "private_key",
    "token",
    "session",
    "csrftoken",
    "sessionid",
    "x_csrftoken",
    "x_forwarded_for",
    "set_cookie",
    "cookie",
    "authorization",
    "proxy-authorization",
    "x_api_key",
    "aiohttp_session",
    "connect.sid",
    "csrf_token",
    "csrf",
    "_csrf",
    "_csrf_token",
    "phpsessid",
    "_session",
    "symfony",
    "user_session",
    "_xsrf",
    "xsrf-token",
    "client_secret",
    "access_token",
    "refresh_token",
    "id_token",
    "x-amz-signature",
    "x-amz-credential",
    "x-amz-security-token",
    "sig",
    "x-goog-signature",
  ].map((key) => key.toLowerCase()),
);

export function isSensitive(key: string): boolean {
  return SENSITIVE.has(key.toLowerCase());
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object" || value === null) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    redacted[key] = isSensitive(key) ? REDACTED : redact(inner);
  }
  return redacted;
}

function entries(pairs: Iterable<[string, string]>): Record<string, unknown> {
  const collected: Record<string, unknown> = {};
  for (const [key, value] of pairs) {
    const previous = collected[key];
    if (previous === undefined) {
      collected[key] = value;
    } else if (Array.isArray(previous)) {
      previous.push(value);
    } else {
      collected[key] = [previous, value];
    }
  }
  return collected;
}

export function bodyOf(text: string | undefined, contentType: string | null): unknown {
  if (text === undefined || text.length === 0 || Buffer.byteLength(text) > MAX_BODY_BYTES) {
    return undefined;
  }
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "application/x-www-form-urlencoded") {
    return entries(new URLSearchParams(text));
  }
  if (type !== "application/json" && !type.endsWith("+json")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface HttpCall {
  tool: Tool;
  params: Record<string, unknown>;
}

export function describe(method: string, address: URL, body?: unknown): HttpCall {
  const name = method.toUpperCase();
  const params: Record<string, unknown> = {
    method: name,
    url: `${address.protocol}//${address.host}${address.pathname}`,
    query: redact(entries(address.searchParams)),
  };
  if (body !== undefined) params.body = redact(body);
  return {
    tool: { name: `${name} ${address.pathname}`, kind: "http", server: address.host },
    params,
  };
}

export function matches(pattern: string, host: string): boolean {
  const parts = pattern.toLowerCase().split("*");
  const value = host.toLowerCase();
  if (parts.length === 1) return value === parts[0];
  let position = 0;
  for (const [index, part] of parts.entries()) {
    if (index === 0) {
      if (!value.startsWith(part)) return false;
      position = part.length;
      continue;
    }
    if (index === parts.length - 1) {
      return value.length - part.length >= position && value.endsWith(part);
    }
    const found = value.indexOf(part, position);
    if (found < 0) return false;
    position = found + part.length;
  }
  return true;
}
