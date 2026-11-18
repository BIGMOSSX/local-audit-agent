export const FORBIDDEN_CJK: string[];
export const FORBIDDEN_SUBSTRINGS: string[];
export const NAME_PATTERNS: { label: string; re: RegExp }[];
export function runChecks(root: string): { name: string; violations: string[] }[];
