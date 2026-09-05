/**
 * 108 FR-003 — "would a money email for this member reach anyone?"
 *
 * This exists so PRESENTATION can ask that question without wiring
 * Infrastructure by hand. The three admin surfaces that show the
 * `NoPrimaryContactBanner` (member detail, invoice detail, credit-note detail)
 * first called `resolveMoneyRecipient(recipientLocaleAdapter, …)` directly,
 * which put an `application/lib` helper and an infra adapter in a server
 * component — Constitution Principle III (NON-NEGOTIABLE) says Presentation
 * calls Application USE CASES only, and `plan.md` ticks that box. A use case
 * plus a deps factory is the shape the rest of this module already uses
 * (`makeResendPdfDeps`, `makeGetInvoiceDeps`), so the pages now look like every
 * other page here.
 *
 * It delegates to `resolveMoneyRecipient` rather than re-deriving anything: the
 * whole point of FR-003 is that the banner and the money path cannot disagree
 * about what counts as deliverable. Whatever the resolver treats as
 * `no_recipient` — no live primary contact, or one whose address column is
 * empty — is what the banner reports.
 *
 * Returns a `Result` rather than a bare boolean because the read CAN fail (the
 * adapter opens its own `runInTenant`), and a failure is not the same fact as
 * "this member has no contact". The caller decides what to render on a failed
 * read; it must not silently become a claim about the member's data.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { errKind, rootCause } from '@/lib/log-id';
import type { RecipientLocalePort } from '../ports/recipient-locale-port';

export interface GetMemberMoneyRecipientStatusDeps {
  readonly recipientLocale: RecipientLocalePort;
}

export interface GetMemberMoneyRecipientStatusInput {
  readonly tenantId: string;
  readonly memberId: string;
}

export interface MemberMoneyRecipientStatus {
  /**
   * True ⇒ staff should be told: money emails for this member are being
   * skipped and a contact fix will restore them.
   *
   * FALSE for an erased or archived member even though they have no live
   * primary contact, because no money email is due for them — and for an
   * erased one, "add or promote a contact" is advice to re-introduce PII for
   * an Art.17 data subject. Erasure guarantees the empty read rather than
   * merely allowing it: `scrubPiiForMemberInTx` sets `is_primary = false` AND
   * `removed_at` on every contact, so before this the banner fired on every
   * invoice an erased member had ever had. (Round-5 finding #2.)
   */
  readonly shouldWarn: boolean;
  /** Present when the member has no live primary contact but no warning is due. */
  readonly suppressedBecause: 'erased' | 'archived' | null;
}

/** The read itself failed — NOT a statement about the member's contacts. */
export interface MoneyRecipientStatusReadFailed {
  readonly code: 'read_failed';
}

export async function getMemberMoneyRecipientStatus(
  deps: GetMemberMoneyRecipientStatusDeps,
  input: GetMemberMoneyRecipientStatusInput,
): Promise<Result<MemberMoneyRecipientStatus, MoneyRecipientStatusReadFailed>> {
  try {
    // `tx = null` — this runs outside any money transaction, so the adapter
    // self-scopes via `runInTenant`.
    const status = await deps.recipientLocale.getMemberRecipientStatus(
      null,
      input.tenantId,
      input.memberId,
    );
    // No such member in this tenant: nothing to warn about, and this is not a
    // read failure either.
    if (status === null) return ok({ shouldWarn: false, suppressedBecause: null });
    if (status.hasLivePrimary) return ok({ shouldWarn: false, suppressedBecause: null });
    if (status.erased) return ok({ shouldWarn: false, suppressedBecause: 'erased' });
    if (status.archived) return ok({ shouldWarn: false, suppressedBecause: 'archived' });
    return ok({ shouldWarn: true, suppressedBecause: null });
  } catch (e) {
    // Boundary never throws (Principle VIII). The cause is logged HERE rather
    // than handed back: an earlier version returned a bare `read_failed` while
    // its own JSDoc claimed the pages logged the cause — they could not, and
    // all three logged with no `err` field at all, so a Neon timeout, a missing
    // enum value and an RLS denial were indistinguishable in the log. (Round-5
    // finding #3.) `errKind` reports the error CLASS, never its message, which
    // can embed user-submitted values.
    logger.warn(
      { tenantId: input.tenantId, memberId: input.memberId, err: errKind(rootCause(e)) },
      'getMemberMoneyRecipientStatus: live primary-contact read failed — banner suppressed',
    );
    return err({ code: 'read_failed' });
  }
}
