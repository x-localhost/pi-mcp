import { createHash } from 'node:crypto';

export function stableStringify(value) {
  return JSON.stringify(value, (_key, item) =>
    item && !Array.isArray(item) && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item);
}

export function sha256Hex(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

// git commit identifiers (SHA-1), distinct from the SHA-256 content digests
// used for code/contract/verification binding below.
export const GIT_SHA = /^[0-9a-f]{40}$/;
export const HEX64 = /^[0-9a-f]{64}$/;
export const CONFIG_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
