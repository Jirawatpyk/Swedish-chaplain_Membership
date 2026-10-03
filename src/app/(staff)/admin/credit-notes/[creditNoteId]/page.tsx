/**
 * F4 US7 AS2 — `/admin/credit-notes/[creditNoteId]` detail page.
 *
 * Target of the F3 member-timeline click-through for
 * `credit_note_issued` events (resolve-invoice-event-copy.ts:61 points
 * here). Read-only surface: credit notes are immutable after issue,
 * there are no mutating actions on this page. Admins who need to
 * adjust further must issue a second partial credit note from the
 * original invoice (US6).
 *
 * Layout: DetailContainer (72rem) per docs/ux-standards.md § 18 —
 * matches the sibling invoice-detail page and the read-only nature
 * of this surface.
 *
 * RBAC: `requireSession('staff')` (admin + manager read). `member`
 * role is rejected at the layout; this page does not need extra
 * checks beyond the session gate.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  getCreditNote,
  makeGetCreditNoteDeps,
  getMemberMoneyRecipientStatus,
  makeMemberMoneyRecipientStatusDeps,
} from '@/modules/invoicing';
// G-5 — sibling-CN navigation. The list is an admin-view convenience
// (no new use-case); same escape-hatch pattern as the settings +
// credit-note list reads already used on the invoice detail page.
 
import { makeDrizzleCreditNoteRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo';
// Raw repo read mirrors the escape hatch used by the invoice detail
// page (invoices/[invoiceId]/page.tsx:32). Application-layer
// `getStaffUser` passthrough is pending Phase-10 consolidation.
 
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import { asUserId } from '@/modules/auth';
import { DetailContainer } from '@/components/layout';
import { renderCreditNoteDetailView } from '../_components/credit-note-detail-view';
import { logger } from '@/lib/logger';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.creditNotes.detail.meta');
  return { title: t('title') };
}

// F4/F5 polish retrospective Phase E (2026-05-17) — `force-dynamic`
// paired with sibling not-found.tsx restores HTTP 404 status on
// `notFound()`. See admin/invoices/[invoiceId]/page.tsx for rationale.
export const dynamic = 'force-dynamic';

export default async function CreditNoteDetailPage({
  params,
}: {
  params: Promise<{ creditNoteId: string }>;
}) {
  const { creditNoteId } = await params;
  const { user } = await requirePagePermission('invoicing.read');

  const hdrs = await headers();
  const requestId = requestIdFromHeaders(hdrs);
  const tenantCtx = resolveTenantFromHeaders(hdrs);

  // 016 T030 — the LITERAL role, narrowed to the STAFF arm of the actor
  // union (the page gate already denies members; the old ternary escalated
  // any non-manager role to 'admin' in the stamp).
  const sessionRole = user.role;
  if (sessionRole === 'member') notFound();

  const result = await getCreditNote(makeGetCreditNoteDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    creditNoteId,
    actor: {
      userId: user.id,
      role: sessionRole,
      requestId,
    },
  });
  if (!result.ok) notFound();
  const cn = result.value;

  // Best-effort resolve the issuer's email for display. Falls back to
  // the raw UUID if the user was deleted — never throws so a missing
  // actor does not 500 the page.
  const issuerUser = await userRepo.findById(asUserId(cn.issuedByUserId)).catch(() => null);
  const issuerLabel = issuerUser?.email ?? cn.issuedByUserId;

  const invoiceHref = `/admin/invoices/${cn.originalInvoiceId}`;

  // 108 FR-003 — this page carries a Resend action, so it must also carry the
  // warning that explains why a resend will refuse.
  //
  // Asks the USE CASE, which asks the resolver: the banner and the money path
  // must not disagree about what counts as deliverable (an inline
  // `isPrimary && removedAt === null` missed the empty-address case), and
  // Presentation calls use cases only (Principle III). A failed read is logged
  // and the banner hidden — it is not a statement about the member's contacts.
  //
  // Archived and erased members are excluded by the use case (round-5 #2) —
  // no money email is due for either, and for an erased one "add a contact" is
  // advice to re-introduce PII for an Art.17 data subject.
  const cnMemberId = cn.originalInvoiceMemberId;
  let noPrimaryContact = false;
  if (cnMemberId !== null) {
    const recipientStatus = await getMemberMoneyRecipientStatus(
      makeMemberMoneyRecipientStatusDeps(),
      { tenantId: tenantCtx.slug, memberId: cnMemberId },
    );
    if (recipientStatus.ok) {
      noPrimaryContact = recipientStatus.value.shouldWarn;
    } else {
      logger.warn(
        { requestId, tenantId: tenantCtx.slug, memberId: cnMemberId },
        'admin.creditNotes.detail.recipient_status_read_failed — banner suppressed',
      );
    }
  }

  // G-5 — sibling CNs on the same original invoice. Best-effort:
  // a repo failure never 500s the page (this is a convenience nav
  // block, not load-bearing). Filter self + sort oldest→newest so
  // the visual order matches the sequence the admin issued them in.
  const siblings = await makeDrizzleCreditNoteRepo(tenantCtx.slug)
    .findByOriginalInvoice(cn.originalInvoiceId, tenantCtx.slug)
    .then((all) =>
      all
        .filter((s) => s.creditNoteId !== cn.creditNoteId)
        .sort((a, b) => a.sequenceNumber - b.sequenceNumber),
    )
    .catch(() => [] as never[]);

  return (
    <DetailContainer>
      {await renderCreditNoteDetailView({
        creditNoteId: cn.creditNoteId,
        documentNumber: cn.documentNumber.raw,
        isRefund: cn.sourceRefundId !== null,
        issueDate: cn.issueDate,
        issuerLabel,
        memberId: cnMemberId,
        memberName: cn.memberIdentitySnapshot.legal_name,
        originalDocuments: cn.originalDocuments ?? null,
        invoiceHref,
        creditAmountSatang: cn.creditAmount.satang,
        vatSatang: cn.vat.satang,
        totalSatang: cn.total.satang,
        reason: cn.reason,
        siblings: siblings.map((s) => ({ creditNoteId: s.creditNoteId, documentNumber: s.documentNumber.raw })),
        noPrimaryContact,
        issuer: {
          legalNameTh: cn.tenantIdentitySnapshot.legal_name_th,
          legalNameEn: cn.tenantIdentitySnapshot.legal_name_en,
          taxId: cn.tenantIdentitySnapshot.tax_id,
          addressTh: cn.tenantIdentitySnapshot.address_th,
          addressEn: cn.tenantIdentitySnapshot.address_en,
        },
        customer: {
          legalName: cn.memberIdentitySnapshot.legal_name,
          taxId: cn.memberIdentitySnapshot.tax_id ?? null,
          address: cn.memberIdentitySnapshot.address,
          contactEmail: cn.memberIdentitySnapshot.primary_contact_email ?? null,
        },
      })}
    </DetailContainer>
  );
}
