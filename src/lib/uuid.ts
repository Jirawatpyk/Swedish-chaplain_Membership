/**
 * UUID v4 generator for client-side idempotency keys.
 * Uses Web Crypto API (available in modern browsers + Node 19+).
 */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}
