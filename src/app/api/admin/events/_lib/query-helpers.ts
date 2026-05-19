/**
 * Shared query-parsing helpers for `/api/admin/events/**` route
 * handlers. Collocated under `_lib/` so they live next to their
 * consumers without polluting `src/lib/` (these are F6-events-API
 * specific). Mirrors F8 precedent at `src/lib/renewals-route-helpers.ts`.
 *
 * extracted from /api/admin/events/route.ts
 * and /api/admin/events/[eventId]/route.ts where the same 36 lines of
 * `clampPageSize` + `coerceBoolean` were copy-pasted.
 */

/**
 * Clamp a `pageSize` query value to `[min, max]` with a default for
 * absent / non-numeric input. Returns the clamped value + a flag
 * indicating whether clamping fired — drives the
 * `X-PageSize-Clamped: true` response header per E8 verify-finding.
 *
 * Behaviour:
 * • non-numeric / null → `{ value: def, clamped: false }`
 * • below `min` → `{ value: min, clamped: true }`
 * • above `max` → `{ value: max, clamped: true }`
 * • in-range → `{ value: n, clamped: false }`
 */
export function clampPageSize(
  raw: string | null,
  min: number,
  max: number,
  def: number,
): { readonly value: number; readonly clamped: boolean } {
  if (raw === null) return { value: def, clamped: false };
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return { value: def, clamped: false };
  if (n < min) return { value: min, clamped: true };
  if (n > max) return { value: max, clamped: true };
  return { value: n, clamped: false };
}

/**
 * Coerce a query-string boolean to a real boolean.
 *
 * • `'true'` / `'1'` → `true`
 * • `''` / `'false'` / `'0'` → `false`
 * • anything else → `undefined` (so `z.preprocess(coerceBoolean, z.boolean())`
 * falls through to the schema default; prevents `?flag=xyzzy` from
 * being coerced to `true` via `Boolean(s)`).
 */
export function coerceBoolean(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  if (v === '' || v === 'false' || v === '0') return false;
  if (v === 'true' || v === '1') return true;
  return undefined;
}
