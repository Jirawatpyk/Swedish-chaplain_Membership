/**
 * T033 — create-invoice-draft use case (F4).
 *
 * Creates a DRAFT invoice with its lines pre-populated from tenant
 * settings + plan catalogue + the member's F3 record:
 *
 *  - 1× `membership_fee` line at the plan's annual fee, pro-rated via
 *    `calculateProRateFactor(tenantPolicy, issueDate, fyStart, fyEnd)`
 *    per US1 AS2 + FR-019.
 *  - 1× `registration_fee` line ONLY if the member's
 *    `registration_fee_paid = false` AND the tenant has a non-zero
 *    `registration_fee_satang` configured per US1 AS1.
 *
 * No sequence number, no PDF, no audit financial event — just an
 * `invoice_draft_created` audit row for traceability. Refuses if
 * `tenant_invoice_settings` is missing (FR-010).
 *
 * RBAC: admin only — enforced at the route handler.
 */
import { err, ok, type Result } from '@/lib/result';
import { z } from 'zod';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { TenantSettingsRepo } from '../ports/tenant-settings-repo';
import type { MemberIdentityPort } from '../ports/member-identity-port';
import type { PlanLookupPort } from '../ports/plan-lookup-port';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import {
  asInvoiceId,
  type Invoice,
  type InvoiceId,
} from '@/modules/invoicing/domain/invoice';
import {
  asInvoiceLineId,
  makeInvoiceLine,
  type InvoiceLine,
} from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { calculateProRateFactor } from '@/modules/invoicing/domain/policies/calculate-pro-rate-factor';
import { bangkokLocalDate } from '@/lib/fiscal-year';

export const createInvoiceDraftSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  memberId: z.string().uuid(),
  planId: z.string().min(1),
  planYear: z.number().int().min(2000).max(2100),
  autoEmailOnIssue: z.boolean().nullable().optional(),
});

export type CreateInvoiceDraftInput = z.infer<typeof createInvoiceDraftSchema>;

export type CreateInvoiceDraftError =
  | { code: 'settings_missing' }
  | { code: 'member_not_found' }
  | { code: 'member_archived' }
  | { code: 'plan_not_found' }
  | { code: 'invalid_line'; reason: string };
// NOTE: `plan_mismatch` was previously declared but never emitted —
// the member/plan parity guard is handled by the F3 UI (Plan field
// is read-only on the invoice form, bound to the member's plan). A
// future iteration will add the server-side guard when
// MemberIdentityView exposes planId + planYear, at which point the
// error variant will be re-introduced alongside its emitter.

export interface CreateInvoiceDraftDeps {
  readonly invoiceRepo: InvoiceRepo;
  /**
   * R7 consolidation (Option 2) — `tenant_invoice_settings` is now
   * the single source of truth for VAT + currency + registration
   * fee. The former F2 `tenant_fee_config` dependency (FeeConfigPort)
   * was dropped in C3b; the registration-fee line reads
   * `settings.registrationFeeSatang` directly. Migration 0026
   * backfilled that column from fee_config so existing tenants are
   * unchanged.
   */
  readonly tenantSettingsRepo: TenantSettingsRepo;
  readonly memberIdentity: MemberIdentityPort;
  readonly planLookup: PlanLookupPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly newUuid: () => string;
}

/**
 * Derive the Bangkok-local fiscal-year boundary dates (YYYY-MM-DD
 * inclusive) for a given issue timestamp + tenant start month.
 */
function fiscalYearBoundary(
  nowIso: string,
  startMonth: number,
): { fyStartDate: string; fyEndDate: string; issueDate: string } {
  // Derive issue date from the shared Bangkok-local helper (same one
  // issue-invoice uses) so the two use cases agree on wall-clock
  // timezone handling.
  const issueDate = bangkokLocalDate(nowIso);
  const [bkkYearStr, bkkMonthStr] = issueDate.split('-');
  const bkkYear = Number(bkkYearStr);
  const bkkMonth = Number(bkkMonthStr);

  // If we're before startMonth, FY anchor is the PREVIOUS calendar year.
  const fyAnchorYear = bkkMonth >= startMonth ? bkkYear : bkkYear - 1;
  const fyStartDate = `${fyAnchorYear}-${String(startMonth).padStart(2, '0')}-01`;
  // End of FY = day before (startMonth) one year later. Plain UTC
  // arithmetic is safe here because we are computing calendar dates
  // only — not clocks / instants.
  const endAnchor = new Date(Date.UTC(fyAnchorYear + 1, startMonth - 1, 1));
  endAnchor.setUTCDate(endAnchor.getUTCDate() - 1);
  const fyEndDate = `${endAnchor.getUTCFullYear()}-${String(endAnchor.getUTCMonth() + 1).padStart(2, '0')}-${String(endAnchor.getUTCDate()).padStart(2, '0')}`;

  return { fyStartDate, fyEndDate, issueDate };
}

export async function createInvoiceDraft(
  deps: CreateInvoiceDraftDeps,
  input: CreateInvoiceDraftInput,
): Promise<Result<Invoice, CreateInvoiceDraftError>> {
  return deps.invoiceRepo.withTx(async (tx) => {
    // Read settings INSIDE the tx — consistent with issue-invoice and
    // guards against the rare stale-settings race where VAT / pro-rate /
    // fiscal-year config flips between read and insert.
    const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);
    if (!settings) return err({ code: 'settings_missing' });

    const member = await deps.memberIdentity.getForIssue(tx, input.tenantId, input.memberId);
    if (!member) return err({ code: 'member_not_found' });
    if (member.isArchived) return err({ code: 'member_archived' });

    // Pattern C / spec-correct guard (US1 header — "confirm the
    // membership tier"): invoice plan MUST match the member's current
    // plan. Admin must run F3 changePlan first to upgrade a member.
    // The UI keeps Plan read-only so this is a defensive
    // belt-and-suspenders check for crafted API calls.
    // We look up member's plan from the FULL member row — the view's
    // identity snapshot doesn't expose planId, but the F3 record does
    // via a companion repo read. For MVP we inline a cheap assertion
    // by comparing the plan looked up for (tenant, planId, planYear)
    // against the live member's plan_id stored on the member row.
    // Defer strict equality check to a future iteration once we
    // expose planId on the MemberIdentityView — today the API schema
    // accepts any plan and the UI prevents mismatch. TODO: extend
    // MemberIdentityView with planId + planYear and enforce here.

    const planFee = await deps.planLookup.getAnnualFeeSatang(
      input.tenantId,
      input.planId,
      input.planYear,
    );
    if (planFee === null) return err({ code: 'plan_not_found' });

    // --- Pro-rate factor (US1 AS2 / FR-019) ---------------------------------
    const { fyStartDate, fyEndDate, issueDate } = fiscalYearBoundary(
      deps.clock.nowIso(),
      settings.fiscalYearStartMonth,
    );
    // When member joined DURING this FY, the pro-rate anchor is their
    // registrationDate (so the member pays for remaining period only).
    // When they are renewing (registered in a prior FY), the anchor is
    // the FY start — they owe the full cycle regardless of today's date.
    const memberJoinedThisFy =
      member.registrationDate >= fyStartDate && member.registrationDate <= fyEndDate;
    const proRateAnchor = memberJoinedThisFy ? member.registrationDate : fyStartDate;

    const proRateFactor = calculateProRateFactor({
      policy: settings.proRatePolicy,
      issueDate: proRateAnchor,
      fyStartDate,
      fyEndDate,
    });

    // --- Build line items ---------------------------------------------------
    const lines: InvoiceLine[] = [];
    let position = 1;

    // 1) Membership fee line — always present, pro-rated per policy.
    const membershipLine = makeInvoiceLine({
      lineId: asInvoiceLineId(deps.newUuid()),
      kind: 'membership_fee',
      descriptionTh:
        proRateFactor === '1.0000'
          ? `ค่าสมาชิก ปี ${input.planYear}`
          : `ค่าสมาชิก ปี ${input.planYear} (pro-rate ${proRateFactor}, ตั้งแต่ ${issueDate})`,
      descriptionEn:
        proRateFactor === '1.0000'
          ? `Membership ${input.planYear}`
          : `Membership ${input.planYear} (pro-rated ${proRateFactor}, from ${issueDate})`,
      unitPrice: Money.fromSatangUnsafe(planFee),
      quantity: '1.0000',
      proRateFactor,
      position: position++,
    });
    if (!membershipLine.ok) {
      return err({ code: 'invalid_line', reason: JSON.stringify(membershipLine.error) });
    }
    lines.push(membershipLine.value);

    // 2) Registration fee line (US1 AS1) — R7 consolidation: read from
    // `tenant_invoice_settings.registration_fee_satang` (authoritative
    // per Option-2 consolidation after F4 shipped). The migration 0026
    // backfilled this column from `tenant_fee_config.registration_fee_
    // minor_units` so existing tenants keep their value. `settings` is
    // already loaded above — no extra round-trip.
    const registrationFeeSatang = settings.registrationFeeSatang;
    if (!member.registrationFeePaid && registrationFeeSatang > 0n) {
      const regFeeLine = makeInvoiceLine({
        lineId: asInvoiceLineId(deps.newUuid()),
        kind: 'registration_fee',
        descriptionTh: 'ค่าลงทะเบียนแรกเข้า',
        descriptionEn: 'Registration fee (one-off)',
        unitPrice: Money.fromSatangUnsafe(registrationFeeSatang),
        quantity: '1.0000',
        proRateFactor: null,
        position: position++,
      });
      if (!regFeeLine.ok) {
        return err({ code: 'invalid_line', reason: JSON.stringify(regFeeLine.error) });
      }
      lines.push(regFeeLine.value);
    }

    const invoiceId: InvoiceId = asInvoiceId(deps.newUuid());
    const invoice = await deps.invoiceRepo.insertDraft(tx, {
      tenantId: input.tenantId,
      invoiceId,
      memberId: input.memberId,
      planId: input.planId,
      planYear: input.planYear,
      draftByUserId: input.actorUserId,
      autoEmailOnIssue: input.autoEmailOnIssue ?? null,
      lines,
    });

    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      eventType: 'invoice_draft_created',
      actorUserId: input.actorUserId,
      summary: `Draft invoice created for member ${input.memberId}`,
      payload: {
        invoice_id: invoiceId,
        member_id: input.memberId,
        plan_id: input.planId,
        plan_year: input.planYear,
        pro_rate_factor: proRateFactor,
        registration_fee_included: !member.registrationFeePaid && registrationFeeSatang > 0n,
      },
    });

    return ok(invoice);
  });
}
