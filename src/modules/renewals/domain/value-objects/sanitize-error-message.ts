/**
 * F8 — Pure sanitiser for third-party error messages before they
 * persist to `audit_log.payload.failure_message` (5-year retention)
 * or pino logs.
 *
 * Originally lived in `src/modules/renewals/infrastructure/resend-
 * transactional-renewal-gateway.tsx` (Round 1+ K13-3 / K15 lineage).
 * Round 6 W-004 hoisted it to the Domain layer because the
 * `acceptTierUpgrade` Application use-case needs to call it on the
 * GatewayResult.threw branch — and Application MUST NOT import from
 * Infrastructure (Constitution Principle III).
 *
 * Strategy (defence-in-depth on top of REDACT_PATHS in pino):
 *   1. Strip Resend API-key prefixes: `re_xxxxxxxxxxxx…`.
 *   2. Strip email addresses (RFC-light pattern).
 *   3. Strip domain-like tokens (anything that looks like
 *      `something.tld` over a closed TLD allowlist).
 *   4. Truncate to 100 chars — error names + cause classification
 *      carry the forensic value; the freeform suffix adds little.
 *
 * The resulting string is safe to persist in audit_log AND to log via
 * pino in dev/staging.
 *
 * Pure — no framework imports (Constitution Principle III).
 */
export function sanitizeResendErrorMessage(message: string): string {
  return (
    message
      // 1. Resend API-key prefix tokens
      .replace(/re_[A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]')
      // 2. Email addresses (RFC-light)
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]')
      // 3. Domain-like tokens (catches sending domains + bare URLs).
      //    K14-7 (R13-S4): the LHS uses `(?:[A-Za-z0-9-]+\.)+` so
      //    multi-label hostnames (e.g. `swecham.zyncdata.app`) are
      //    captured whole instead of leaving the leftmost subdomain
      //    label unredacted. Single-label form (`example.com`) still
      //    matches because `+` allows exactly one repetition.
      //
      //    K15-4 (R14-S2): TLD allowlist extended to cover chamber
      //    locale TLDs the SweCham deployment may interact with —
      //    `.se` (Swedish), `.th` (Thai), `.au` (Australian),
      //    `.uk`/`.de`/`.nl`/`.fr`/`.es`/`.it`/`.ch`/`.be`/`.dk`/`.fi`
      //    (other European chambers); plus the legacy `.gov`/`.edu`
      //    that occasionally appear in member contact emails. Closed
      //    set by design: domains with truly-novel TLDs still pass
      //    through (audited as accepted residual; pinned by the
      //    "TLD outside allowlist" test in K15-5).
      .replace(/\b(?:[A-Za-z0-9-]+\.)+(?:com|net|org|io|co|app|dev|tech|cloud|ai|to|me|info|biz|email|mail|tld|se|th|au|uk|de|nl|fr|es|it|ch|be|dk|fi|gov|edu)\b/gi, '[REDACTED_DOMAIN]')
      // 4. Cap length to 100 chars.
      //    K15-3 (R14-S1): tighter than the 200-char cron-warn-log
      //    cap because THIS output persists in
      //    `audit_log.payload.failure_message` for 5 years
      //    (Constitution Principle I + F4 retention rule).
      .slice(0, 100)
      .trim()
  );
}
