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
  /**
   * F8-completion Slice 1 (FR-022) — RENEWAL signal. When present, the
   * draft is a §86/4 renewal invoice and the membership line is billed
   * at the cycle's FROZEN price instead of the live F2 catalogue price
   * (`getAnnualFeeSatang`). `unitPriceSatang` is the **VAT-EXCLUSIVE**
   * membership unit price in satang (VAT 7% is added on top at issue via
   * `calculateVat` — this is the OPPOSITE of the event-path
   * `amountOverride` which is VAT-INCLUSIVE). The value is server-sourced
   * from the cycle row's `frozen_plan_price_thb` (parsed integer-only via
   * `parseThbDecimalToSatang` in the F4↔F8 bridge adapter) — NEVER a
   * request body, because a renewal §86/4 is a price-tampering surface on
   * a tax document. When set, the use-case also forces `proRateFactor =
   * '1.0000'` (a renewal of an existing member is the full cycle) and
   * suppresses the one-off `registration_fee` re-bill line.
   */
  renewalSignal: z
    .object({ unitPriceSatang: z.bigint() })
    .optional(),
});

export type CreateInvoiceDraftInput = z.infer<typeof createInvoiceDraftSchema>;

export type CreateInvoiceDraftError =
  | { code: 'settings_missing' }
  | { code: 'member_not_found' }
  | { code: 'member_archived' }
  | { code: 'plan_not_found' }
  | { code: 'invalid_line'; reason: string };
// NOTE: a `plan_mismatch` variant is intentionally ABSENT — the
// member/plan parity guard is UI-enforced today (the invoice form's Plan
// field is read-only, bound to the member's plan). See the parity-guard
// TODO in `createInvoiceDraft` for the deferred server-side follow-up.

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
 * Fiscal-year boundary dates (YYYY-MM-DD inclusive) for an EXPLICIT fiscal-year
 * anchor year: FY `n` runs from `n-startMonth-01` to the day before `startMonth`
 * one year later. Pure calendar math (no clock) — the correct source for the
 * COVERAGE PERIOD an invoice bills (the FY the invoice is FOR = `planYear`, NOT
 * wall-clock "now"; an early renewal issued in Dec-2026 for FY2027 must show
 * FY2027's coverage).
 */
function fiscalYearBoundaryForYear(
  fyAnchorYear: number,
  startMonth: number,
): { fyStartDate: string; fyEndDate: string } {
  const fyStartDate = `${fyAnchorYear}-${String(startMonth).padStart(2, '0')}-01`;
  // End of FY = day before (startMonth) one year later. Plain UTC arithmetic is
  // safe here because we compute calendar dates only — not clocks / instants.
  const endAnchor = new Date(Date.UTC(fyAnchorYear + 1, startMonth - 1, 1));
  endAnchor.setUTCDate(endAnchor.getUTCDate() - 1);
  const fyEndDate = `${endAnchor.getUTCFullYear()}-${String(endAnchor.getUTCMonth() + 1).padStart(2, '0')}-${String(endAnchor.getUTCDate()).padStart(2, '0')}`;
  return { fyStartDate, fyEndDate };
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
  return { ...fiscalYearBoundaryForYear(fyAnchorYear, startMonth), issueDate };
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

    // TODO (server-side plan-parity guard): invoice plan MUST match the
    // member's current plan (US1 "confirm the membership tier"). Enforced
    // by the UI today (Plan field read-only, bound to the member's plan);
    // the server-side check is deferred until `MemberIdentityView` exposes
    // planId + planYear, at which point re-introduce the `plan_mismatch`
    // error variant + its emitter here.

    // F8-completion Slice 1 (FR-022) — RENEWAL path. When a renewal
    // signal is present, the membership line is billed at the cycle's
    // FROZEN price (VAT-exclusive satang) carried on the signal, NOT the
    // live F2 catalogue price. We still validate the plan resolves (the
    // §86/4 references the plan + the F3 read above already loaded the
    // member) but the resolved live fee is ignored for the line amount.
    const isRenewal = input.renewalSignal !== undefined;

    const planFee = await deps.planLookup.getAnnualFeeSatang(
      input.tenantId,
      input.planId,
      input.planYear,
    );
    // NOTE (068 cluster B — investigated, gate INTENTIONALLY retained on
    // both paths): a code-review finding proposed gating `plan_not_found`
    // only on the non-renewal path so a renewal with a missing catalogue-
    // fee-year could still issue at the frozen `renewalSignal` price. That
    // is INFEASIBLE: the `invoices_plan_fk` constraint (migration 0019)
    // requires `(tenant_id, plan_id, plan_year)` to exist in
    // `membership_plans`, and `getAnnualFeeSatang` returns null when that
    // row is absent (the fee column is NOT NULL; the adapter applies no
    // active/status filter). So for an ABSENT row `planFee === null` ⟺ the
    // FK would fail — removing the gate would only convert a clean early
    // `plan_not_found` into a raw FK 23503 deeper in the insert, with no
    // improvement to the orphan-cycle outcome.
    //
    // 070 §86/4 advisory — the adapter ALSO returns null for a SOFT-DELETED
    // plan-year row (`deleted_at IS NOT NULL`), harmonising with the F8
    // frozen-plan adapter. The FK alone would NOT catch that case (the
    // soft-deleted row physically exists, so `invoices_plan_fk` is
    // satisfied), so this gate is the only thing that stops a §86/4 being
    // issued against a soft-deleted plan. The gate stays on both paths.
    if (planFee === null) return err({ code: 'plan_not_found' });

    // The membership unit price is the FROZEN signal price on a renewal,
    // else the live catalogue fee. Both are VAT-EXCLUSIVE satang.
    const membershipUnitPriceSatang = isRenewal
      ? input.renewalSignal!.unitPriceSatang
      : planFee;

    // --- Pro-rate factor (US1 AS2 / FR-019) ---------------------------------
    const { fyStartDate, fyEndDate, issueDate } = fiscalYearBoundary(
      deps.clock.nowIso(),
      settings.fiscalYearStartMonth,
    );
    // When member joined DURING this FY, the pro-rate anchor is their
    // registrationDate (so the member pays for remaining period only).
    // When they are renewing (registered in a prior FY), the anchor is
    // the FY start — they owe the full cycle regardless of today's date.
    //
    // FR-022 — a renewal is ALWAYS a full cycle: skip the pro-rate
    // derivation entirely and force 1.0000. The frozen price the member
    // agreed to is the full-cycle amount; pro-rating it would bill less
    // than the frozen price and create a §86/10 reconciliation problem.
    const memberJoinedThisFy =
      member.registrationDate >= fyStartDate && member.registrationDate <= fyEndDate;
    const proRateAnchor = memberJoinedThisFy ? member.registrationDate : fyStartDate;

    const proRateFactor = isRenewal
      ? '1.0000'
      : calculateProRateFactor({
          policy: settings.proRatePolicy,
          issueDate: proRateAnchor,
          fyStartDate,
          fyEndDate,
        });

    // 088 T036 (FR-011) — the membership line description MUST include the plan
    // name and the coverage period. The plan name is resolved via the plan-
    // lookup port (Thai falls back to English when the plan has no `th`
    // translation — F2 `LocaleText` only requires `en`); the coverage period is
    // the tenant fiscal-year boundary (Gregorian ISO — storage stays Gregorian,
    // BE is display-only). getPlanName reuses the SAME (tenant, plan, year) +
    // not-soft-deleted filter as the fee gate above, so a draft that resolved a
    // fee also resolves a name; a null (TOCTOU / race) falls back to no name.
    //
    // Forward-only: the enriched string is composed HERE and STORED on the line;
    // the PDF template renders the stored text verbatim (no recompute), so
    // already-drafted/-issued documents keep their original description and only
    // NEW drafts get the plan + period. No template-version gate is needed.
    const planNameParts = await deps.planLookup.getPlanName(
      input.tenantId,
      input.planId,
      input.planYear,
    );
    const planLabelTh = planNameParts?.th ? `${planNameParts.th} ` : '';
    const planLabelEn = planNameParts?.en ? `${planNameParts.en} ` : '';
    // 088 US4 review fix (HIGH) — the COVERAGE PERIOD label is the FY the invoice
    // is FOR (input.planYear), NOT the FY containing wall-clock "now". An early
    // renewal confirmed in Dec-2026 for planYear 2027 must read
    // "coverage 2027-01-01 to 2027-12-31", not now's FY (which printed a
    // self-contradictory §86/4). The pro-rate math above stays now-based (a new
    // member joining THIS FY pro-rates from today); for a new member planYear == the
    // current FY, so the two coincide.
    const { fyStartDate: coverageStart, fyEndDate: coverageEnd } =
      fiscalYearBoundaryForYear(input.planYear, settings.fiscalYearStartMonth);
    // The full-cycle base carries plan name + coverage period; a pro-rated line
    // appends the factor + start date (the historical pro-rate detail retained).
    const membershipDescTh =
      `ค่าสมาชิก ${planLabelTh}ปี ${input.planYear} (ระยะเวลา ${coverageStart} ถึง ${coverageEnd})` +
      (proRateFactor === '1.0000'
        ? ''
        : ` (pro-rate ${proRateFactor}, ตั้งแต่ ${issueDate})`);
    const membershipDescEn =
      `Membership ${planLabelEn}${input.planYear} (coverage ${coverageStart} to ${coverageEnd})` +
      (proRateFactor === '1.0000'
        ? ''
        : ` (pro-rated ${proRateFactor}, from ${issueDate})`);

    // --- Build line items ---------------------------------------------------
    const lines: InvoiceLine[] = [];
    let position = 1;

    // 1) Membership fee line — always present, pro-rated per policy.
    const membershipLine = makeInvoiceLine({
      lineId: asInvoiceLineId(deps.newUuid()),
      kind: 'membership_fee',
      descriptionTh: membershipDescTh,
      descriptionEn: membershipDescEn,
      unitPrice: Money.fromSatangUnsafe(membershipUnitPriceSatang),
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
    // FR-022 — suppress the one-off registration_fee re-bill on the
    // renewal path. A renewal §86/4 bills ONLY the frozen membership
    // price; the one-time entry fee belongs to onboarding, never a
    // renewal cycle. (`isRenewal` short-circuits before the member /
    // settings predicates so a renewal with an unpaid reg fee still
    // never adds the line.)
    const registrationFeeSatang = settings.registrationFeeSatang;
    if (!isRenewal && !member.registrationFeePaid && registrationFeeSatang > 0n) {
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
      // 054-event-fee-invoices — this is the classic membership invoice
      // path: subject='membership', no event linkage, VAT-EXCLUSIVE.
      invoiceSubject: 'membership',
      eventId: null,
      eventRegistrationId: null,
      vatInclusive: false,
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
        registration_fee_included:
          !isRenewal && !member.registrationFeePaid && registrationFeeSatang > 0n,
        // FR-022 — flags a frozen-price renewal §86/4 (membership line
        // billed at the cycle's frozen price, reg-fee suppressed).
        is_renewal: isRenewal,
      },
    });

    return ok(invoice);
  });
}
