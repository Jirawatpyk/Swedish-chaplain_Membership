/**
 * UUID v4 generator for client-side idempotency keys.
 *
 * Uses `crypto.randomUUID()` which is available in:
 *   - Node.js ≥ 14.17.0 (baseline for the project — Node 22 LTS)
 *   - All modern browsers (Safari 15.4+, Chrome 92+, Firefox 95+)
 *
 * No fallback: the project targets Node 22 LTS + modern browsers where
 * the Web Crypto API is universally present. If the runtime lacks
 * `crypto.randomUUID` the function throws — surfacing the environment
 * problem rather than emitting a predictable non-UUID fallback that
 * would undermine idempotency guarantees.
 */
export function uuid(): string {
  return crypto.randomUUID();
}
