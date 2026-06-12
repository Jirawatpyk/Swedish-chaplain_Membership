/**
 * Display-set of error codes the event-fee form maps to a dedicated
 * `admin.invoices.issueAsPaid.errors.*` toast copy on the as-paid path.
 *
 * Extracted from `event-fee-form.tsx` (065 QC S10) so the i18n-coverage
 * unit test can pin against the FORM's ACTUAL set rather than a hand-copied
 * duplicate of the arithmetic — a future change to this set is then caught
 * by `tests/unit/components/invoices/issue-as-paid-error-i18n.test.ts`
 * instead of silently drifting from its copy. This is a pure `.ts` leaf (no
 * React import graph) precisely so that test stays a fast unit `.ts` file.
 *
 * Wave-4 S19 — leaf-module import (NOT the `@/modules/invoicing` barrel):
 * the barrel's runtime graph is server-only (pino logger + node crypto via
 * the use-cases) and must not enter the client bundle. The codes leaf is
 * pure constants with a type-only dependency on the use-case, so it is
 * client-safe. (Allowlisted in
 * `tests/unit/architecture/invoicing-presentation-imports.test.ts` as the
 * single sanctioned application-layer deep import from presentation.)
 *
 * Arithmetic (the canonical leaf set, with two deliberate deltas):
 *   - MINUS `registration_lookup_failed`: internal verification error, not
 *     operator-fixable — stays on the codeFallback toast (no copy key).
 *   - PLUS `'invalid'`: the route-level 400 zod reject, which is not a
 *     use-case code.
 */
import { ISSUE_EVENT_INVOICE_AS_PAID_ERROR_CODES } from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid-codes';

export const AS_PAID_ERROR_CODES: readonly string[] = [
  'invalid',
  ...ISSUE_EVENT_INVOICE_AS_PAID_ERROR_CODES.filter(
    (code) => code !== 'registration_lookup_failed',
  ),
];
