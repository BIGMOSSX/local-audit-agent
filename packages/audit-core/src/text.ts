// Control-char classes are intentional: this is the untrusted-text scrubber.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character scrubbing
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character scrubbing
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Zero-width / format characters hide or forge text in a one-line UI: zero-width, line and paragraph
// separators, soft hyphen, Arabic letter mark, Mongolian vowel separator, invisible math operators,
// deprecated format controls, interlinear annotation, variation selectors and Unicode tag characters.
const INVISIBLE =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: the class is a strip-list; every member is removed individually
  /[\u200b-\u200d\u2060\ufeff\u2028\u2029\u061c\u00ad\u180e\u2061-\u2064\u206a-\u206f\ufff9-\ufffb\ufe00-\ufe0f\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
// Lone surrogates (no `u` flag so they are matched per code unit).
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const CRLF = /\r\n?/g;

// Work is bounded: input is capped to a multiple of the output limit before any regex runs.
const INPUT_CAP_FACTOR = 4;

export function sanitizeEngineText(input: string, maxCodePoints: number): string {
  if (typeof input !== "string") return "";
  if (typeof maxCodePoints !== "number" || Number.isNaN(maxCodePoints) || maxCodePoints < 1)
    return "";
  const limit = Math.floor(maxCodePoints);
  const capped =
    input.length > limit * INPUT_CAP_FACTOR ? input.slice(0, limit * INPUT_CAP_FACTOR) : input;
  const clean = capped
    .replace(LONE_SURROGATE, "\ufffd")
    .replace(ANSI, "")
    .replace(CRLF, "\n")
    .replace(CONTROL, "")
    .replace(BIDI, "")
    .replace(INVISIBLE, "");
  const points = Array.from(clean);
  if (points.length <= limit) return clean;
  return `${points.slice(0, limit - 1).join("")}…`;
}
