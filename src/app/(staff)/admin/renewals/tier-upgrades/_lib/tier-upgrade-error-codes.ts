/**
 * WP6 — tier-upgrade action error-code normaliser (BP5 item 1 + correction C-14).
 *
 * The queue's `callAction` previously surfaced the RAW server code as a toast
 * description (`payment_change_failed`, `suggestion_not_open`, …) — an admin
 * saw machine strings. This maps every code an Accept / Dismiss / Escalate POST
 * can produce to one of a closed set of localised copy keys
 * (`action_errors.<code>`), and handles BOTH envelope shapes:
 *   - the F8 route envelope `{ error: { code } }` (renewals-route-helpers), and
 *   - the flat proxy/middleware envelope `{ error: 'read-only-mode' }` /
 *     `{ error: 'csrf-rejected' }` (src/proxy.ts) — hyphenated, so normalised
 *     to snake_case before lookup.
 *
 * `network_error` is raised by the client catch handler (fetch threw), never by
 * this normaliser; a non-JSON / bodyless error response resolves to
 * `http_error`; an unrecognised code falls through to `unknown`.
 */
export const TIER_UPGRADE_ACTION_ERROR_CODES = [
  'unknown',
  'network_error',
  'http_error',
  'read_only_mode',
  'csrf_rejected',
  'feature_disabled',
  'no_session',
  'forbidden',
  'server_error',
  'invalid_body',
  'invalid_input',
  'suggestion_not_found',
  'suggestion_not_open',
  'no_active_cycle',
  'plan_change_failed',
] as const;

export type TierUpgradeActionErrorCode =
  (typeof TIER_UPGRADE_ACTION_ERROR_CODES)[number];

const KNOWN_CODES = new Set<string>(TIER_UPGRADE_ACTION_ERROR_CODES);

/**
 * Pull the raw code from either envelope shape. Returns `null` for a
 * bodyless / non-object response (e.g. a `.json()` parse failure).
 */
function extractRawCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  // Flat proxy envelope: `{ error: 'read-only-mode' }`.
  if (typeof error === 'string') return error;
  // Nested F8 envelope: `{ error: { code } }`.
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

/**
 * Normalise a parsed error-response body (or `null` for a parse failure) to a
 * closed {@link TierUpgradeActionErrorCode}. Hyphenated proxy codes are folded
 * to snake_case; unrecognised codes collapse to `unknown`.
 */
export function normalizeTierUpgradeErrorCode(
  body: unknown,
): TierUpgradeActionErrorCode {
  const raw = extractRawCode(body);
  if (raw === null) return 'http_error';
  const normalized = raw.replace(/-/g, '_');
  return (
    KNOWN_CODES.has(normalized) ? normalized : 'unknown'
  ) as TierUpgradeActionErrorCode;
}
