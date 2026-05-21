import { createHash, randomInt } from 'crypto';

/**
 * Crockford-safe alphabet for premium-feel keys.
 * Deliberately omits 0, O, 1, I, L to avoid transcription ambiguity.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PREFIX = 'ACP-SL-';
const BODY_LENGTH = 12; // 3 groups of 4 in presentation

function randomChar(): string {
  return ALPHABET[randomInt(0, ALPHABET.length)];
}

/**
 * Generate a single license key in the canonical format:
 *   ACP-SL-XXXX-XXXX-XXXX
 */
export function generateKey(): string {
  const body = Array.from({ length: BODY_LENGTH }, randomChar).join('');
  return `${PREFIX}${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/**
 * Normalize a user-supplied key for hashing:
 * - Upper-case
 * - Strip hyphens and whitespace
 */
export function normalizeKey(key: string): string {
  return key.toUpperCase().replace(/[-\s]/g, '');
}

/**
 * Compute the SHA-256 hash of a normalized key.
 * We never store plaintext keys.
 */
export function hashKey(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Extract a short prefix from the body for admin/support lookup.
 * E.g. "ACP-SL-T7K9-M2VQ-8HJ4" → "T7K9"
 */
export function keyPrefix(key: string): string {
  const body = normalizeKey(key).replace(/^ACPSL/, '');
  return body.slice(0, 4);
}

/**
 * Validate that a key at least looks like ours (prefix + allowed chars).
 * Does NOT prove existence — call the DB for that.
 */
export function looksLikeKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (!normalized.startsWith('ACPSL')) return false;
  const body = normalized.slice('ACPSL'.length);
  if (body.length !== BODY_LENGTH) return false;
  return body.split('').every((c) => ALPHABET.includes(c));
}
