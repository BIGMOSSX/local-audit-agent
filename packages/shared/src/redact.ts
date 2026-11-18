export const REDACTED = "[REDACTED]";

const WHOLE_MATCH_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

// Matches `key=value`, `key: "value"` and JSON `"key":"value"` (also JSON nested inside a JSON
// string, where quotes are backslash-escaped, and the value may itself hold escaped quotes,
// backslashes or newlines). The key may be compound (`access_token`,
// `X-Api-Key`, `accessToken`) as long as it ENDS in a secret word, so `tokens` and `tokenizer`
// stay untouched.
const KEY_VALUE =
  /(?<![A-Za-z0-9_-])(\\?["'])?([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd))\b\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|\\"(?:\\\\\\\\|\\\\\\"|\\\\[^\\"]|[^\\"])*\\"|[^\s,;]+)/gi;

function redactPair(
  _match: string,
  keyQuote: string | undefined,
  key: string,
  sep: string,
  value: string,
): string {
  const q = keyQuote ?? "";
  const valueQuote = value.startsWith('\\"') ? '\\"' : /^["']/.test(value) ? value[0] : "";
  // Inside a quoted (JSON-style) pair keep the value's quotes so the text stays well-formed.
  const shown = q && valueQuote ? `${valueQuote}${REDACTED}${valueQuote}` : REDACTED;
  return `${q}${key}${q}${sep}${shown}`;
}

export function redactSecrets(input: string, extraSecrets: readonly string[] = []): string {
  let out = input;
  for (const secret of extraSecrets) {
    if (secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of WHOLE_MATCH_PATTERNS) out = out.replace(pattern, REDACTED);
  return out.replace(KEY_VALUE, redactPair);
}
