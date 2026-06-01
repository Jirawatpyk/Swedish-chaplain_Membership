/**
 * PDPA / GDPR Art. 5(1)(c) data-minimisation helper — attendee email → SHA-256
 * hex prefix. NEVER store a raw attendee email in an audit_log payload or a log
 * line; store this PII-safe correlator instead.
 *
 * Extracted from `import-csv.ts` (go-live audit S1-P0-1) so the shared
 * `process-attendee-in-tx.ts` helper can reuse it without a circular import
 * (`import-csv` already imports `process-attendee-in-tx`).
 */
import { createHash } from 'node:crypto';

/**
 * Branded SHA-256 hex prefix so a future caller cannot accidentally pass a raw
 * email into a slot that expects a hash. Only `hashAttendeeEmail` can construct
 * values of this type — TypeScript blocks plain-string assignment.
 */
export type EmailHashPrefix = string & {
  readonly __emailHashPrefix: unique symbol;
};

/**
 * Hash `attendee_email` (case-folded) → SHA-256 hex prefix (16 chars). The
 * branded return makes this the only legal source of `EmailHashPrefix` values.
 */
export function hashAttendeeEmail(email: string): EmailHashPrefix {
  return createHash('sha256')
    .update(email.toLowerCase())
    .digest('hex')
    .slice(0, 16) as EmailHashPrefix;
}
