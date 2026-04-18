/**
 * T033 — create-invoice-draft use case (F4).
 *
 * Creates a DRAFT invoice with its lines pre-populated from tenant
 * settings + plan catalogue. No sequence number, no PDF, no audit
 * financial event — just a `invoice_draft_created` audit row for
 * traceability.
 *
 * Refuses if `tenant_invoice_settings` is missing (FR-010).
 *
 * RBAC: admin only — enforced at the route handler using the F1
 * `requireRole('admin')` guard.
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

export const createInvoiceDraftSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  memberId: z.string().uuid(),
  planId: z.string().min(1),
  planYear: z.number().int().min(2000).max(2100),
  autoEmailOnIssue: z.boolean().nullable().optional(),
  customLines: z
    .array(
      z.object({
        kind: z.enum(['membership_fee', 'registration_fee']),
        descriptionTh: z.string().min(1),
        descriptionEn: z.string().min(1),
        unitPriceSatang: z.bigint().nonnegative(),
        quantity: z.string().default('1.0000'),
        proRateFactor: z.string().nullable().default(null),
      }),
    )
    .optional(),
});

export type CreateInvoiceDraftInput = z.infer<typeof createInvoiceDraftSchema>;

export type CreateInvoiceDraftError =
  | { code: 'settings_missing' }
  | { code: 'member_not_found' }
  | { code: 'member_archived' }
  | { code: 'plan_not_found' }
  | { code: 'invalid_line'; reason: string };

export interface CreateInvoiceDraftDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly tenantSettingsRepo: TenantSettingsRepo;
  readonly memberIdentity: MemberIdentityPort;
  readonly planLookup: PlanLookupPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly newUuid: () => string;
}

export async function createInvoiceDraft(
  deps: CreateInvoiceDraftDeps,
  input: CreateInvoiceDraftInput,
): Promise<Result<Invoice, CreateInvoiceDraftError>> {
  const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);
  if (!settings) return err({ code: 'settings_missing' });

  return deps.invoiceRepo.withTx(async (tx) => {
    const member = await deps.memberIdentity.getForIssue(tx, input.tenantId, input.memberId);
    if (!member) return err({ code: 'member_not_found' });
    if (member.isArchived) return err({ code: 'member_archived' });

    const planFee = await deps.planLookup.getAnnualFeeSatang(
      input.tenantId,
      input.planId,
      input.planYear,
    );
    if (planFee === null) return err({ code: 'plan_not_found' });

    // Build default lines if caller didn't pass custom ones.
    const lines: InvoiceLine[] = [];
    const sources = input.customLines ?? [
      {
        kind: 'membership_fee' as const,
        descriptionTh: `ค่าสมาชิก ${input.planYear}`,
        descriptionEn: `Membership ${input.planYear}`,
        unitPriceSatang: planFee,
        quantity: '1.0000',
        // Default factor at draft time = 1.0 (full year); the issue
        // step can replace it with pro-rated factor based on issue
        // date vs fiscal year boundaries.
        proRateFactor: '1.0000',
      },
    ];

    let position = 1;
    for (const src of sources) {
      const built = makeInvoiceLine({
        lineId: asInvoiceLineId(deps.newUuid()),
        kind: src.kind,
        descriptionTh: src.descriptionTh,
        descriptionEn: src.descriptionEn,
        unitPrice: Money.fromSatangUnsafe(src.unitPriceSatang),
        quantity: src.quantity ?? '1.0000',
        proRateFactor: src.proRateFactor ?? (src.kind === 'registration_fee' ? null : '1.0000'),
        position: position++,
      });
      if (!built.ok) return err({ code: 'invalid_line', reason: JSON.stringify(built.error) });
      lines.push(built.value);
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
      },
    });

    return ok(invoice);
  });
}
