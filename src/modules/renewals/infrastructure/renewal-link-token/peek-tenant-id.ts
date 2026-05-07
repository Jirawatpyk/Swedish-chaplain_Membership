/**
 * F8 Phase 5 Wave A · T118 — `peekTokenTenantId(token)` helper.
 *
 * Pre-tenant-bind observability helper for the public renewal-portal
 * entry point (`/portal/renewal/[memberId]?token=...`). The route
 * handler resolves `tenantFromRequest` via F1's existing
 * `resolveTenantFromRequest()` abstraction — this helper independently
 * peeks at the token's claimed `tid` so logs / traces / audit
 * breadcrumbs can carry it BEFORE the verifier runs.
 *
 * Important security note:
 *   - This helper does NOT verify the HMAC, decode the structured
 *     payload, or check `exp`. It returns whatever string sits in the
 *     `tid` field of the wire-format payload, raw.
 *   - DO NOT branch on the returned `tid` for any access-control,
 *     authorization, or DB-binding decision. Use the
 *     `RenewalLinkTokenVerifier` port for that. The point of this
 *     helper is to enrich pre-verify logs with a *claimed* tenant so
 *     subsequent forensics can correlate "request resolved as tenant
 *     X but token claimed tenant Y".
 *
 * Returns `null` when the token is missing / not a string / wire-format
 * malformed / payload non-JSON / `tid` field absent or not a non-empty
 * string. Callers treat `null` as "tenant unknown — log under the
 * request-resolved tenant and let the verifier reject".
 *
 * Pure utility — only `node:buffer` import needed; no framework / ORM /
 * Application-port direct imports (Constitution Principle III).
 */

function base64urlDecode(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  try {
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

export function peekTokenTenantId(rawToken: unknown): string | null {
  if (typeof rawToken !== 'string' || rawToken.length === 0) {
    return null;
  }
  const parts = rawToken.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    return null;
  }
  const b64Payload = parts[1];
  if (!b64Payload) return null;
  const payloadBytes = base64urlDecode(b64Payload);
  if (payloadBytes === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(payloadBytes.toString('utf-8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = (raw as Record<string, unknown>)['tid'];
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  return candidate;
}
