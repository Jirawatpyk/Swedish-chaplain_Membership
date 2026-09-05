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
import { resolveMoneyRecipient } from '../lib/resolve-money-recipient';
import type { RecipientLocalePort } from '../ports/recipient-locale-port';

export interface GetMemberMoneyRecipientStatusDeps {
  readonly recipientLocale: RecipientLocalePort;
}

export interface GetMemberMoneyRecipientStatusInput {
  readonly tenantId: string;
  readonly memberId: string;
}

export interface MemberMoneyRecipientStatus {
  /** False ⇒ every money email for this member is being skipped. */
  readonly deliverable: boolean;
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
    // self-scopes via `runInTenant`. `snapshot = null` is not a fallback: for a
    // non-null memberId the resolver never reads the snapshot at all.
    const recipient = await resolveMoneyRecipient(
      deps.recipientLocale,
      null,
      input.tenantId,
      input.memberId,
      null,
    );
    return ok({ deliverable: recipient.kind !== 'no_recipient' });
  } catch {
    // Boundary never throws (Principle VIII). The error object is deliberately
    // not forwarded: callers only need to know the read failed, and the pages
    // that consume this log the cause themselves with `errKind`.
    return err({ code: 'read_failed' });
  }
}
