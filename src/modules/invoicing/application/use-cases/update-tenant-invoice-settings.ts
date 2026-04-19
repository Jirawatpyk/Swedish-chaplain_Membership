/**
 * R7-B2 — update-tenant-invoice-settings use case (F4 US4 / FR-009).
 *
 * Backs `PATCH /api/tenant-invoice-settings`. First-time write creates
 * the row (FR-010 enforcement then unlocks issuance); subsequent writes
 * patch only caller-provided fields.
 *
 * Emits `tenant_invoice_settings_changed` audit with a structured diff
 * so a manager can later reconstruct "when did VAT flip from 7→10 %".
 *
 * Logo uploads go through the dedicated `/logo` endpoint (sharp re-
 * encode, MIME whitelist, dimension bounds). This use-case accepts the
 * already-validated `logoBlobKey` output of that endpoint — it never
 * receives raw logo bytes (FR-034).
 */
import { err, ok, type Result } from '@/lib/result';
import { z } from 'zod';
import type {
  TenantSettingsRepo,
  TenantInvoiceSettingsPatch,
} from '../ports/tenant-settings-repo';
import type { AuditPort } from '../ports/audit-port';
import { VatRate } from '../../domain/value-objects/vat-rate';

export const updateTenantInvoiceSettingsSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  // Every field optional — partial PATCH. Zod narrows each to its
  // storage shape (e.g. VAT as 4-dp string, `YYYY-MM-DD` ≠ needed here
  // because settings don't carry dates).
  currencyCode: z
    .string()
    .regex(/^[A-Z]{3}$/, 'currencyCode must be 3 uppercase letters (ISO 4217)')
    .optional(),
  vatRate: z
    .string()
    .regex(/^(?:0|[1-9]\d*)\.\d{4}$/, 'vatRate must be 4-dp decimal (e.g. 0.0700)')
    .optional(),
  registrationFeeSatang: z.bigint().nonnegative().optional(),
  legalNameTh: z.string().min(1).max(300).optional(),
  legalNameEn: z.string().min(1).max(300).optional(),
  taxId: z
    .string()
    .regex(/^\d{13}$/, 'taxId must be 13 digits (Thai RD format)')
    .optional(),
  registeredAddressTh: z.string().min(1).max(1000).optional(),
  registeredAddressEn: z.string().min(1).max(1000).optional(),
  invoiceNumberPrefix: z.string().min(1).max(20).optional(),
  creditNoteNumberPrefix: z.string().min(1).max(20).optional(),
  receiptNumberPrefix: z.string().min(1).max(20).nullable().optional(),
  receiptNumberingMode: z.enum(['combined', 'separate']).optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  defaultNetDays: z.number().int().min(0).max(365).optional(),
  proRatePolicy: z.enum(['none', 'monthly', 'daily']).optional(),
  autoEmailEnabled: z.boolean().optional(),
  logoBlobKey: z.string().max(500).nullable().optional(),
});

export type UpdateTenantInvoiceSettingsInput = z.infer<typeof updateTenantInvoiceSettingsSchema>;

export type UpdateTenantInvoiceSettingsError =
  | { code: 'vat_rate_out_of_range'; value: string }
  | { code: 'no_op' };

export interface UpdateTenantInvoiceSettingsDeps {
  readonly tenantSettingsRepo: TenantSettingsRepo;
  readonly audit: AuditPort;
}

export async function updateTenantInvoiceSettings(
  deps: UpdateTenantInvoiceSettingsDeps,
  input: UpdateTenantInvoiceSettingsInput,
): Promise<Result<void, UpdateTenantInvoiceSettingsError>> {
  // Cross-field validation that zod can't express standalone — VAT rate
  // must fit the Domain bound [0, 0.30] (VatRate.of checks this).
  if (input.vatRate !== undefined) {
    const vr = VatRate.of(input.vatRate);
    if (!vr.ok) {
      return err({ code: 'vat_rate_out_of_range', value: input.vatRate });
    }
  }

  // Build the repo patch — only pass caller-provided fields so partial
  // edits don't stomp unrelated columns. `TenantInvoiceSettingsPatch`
  // is readonly at the type level, so construct as a spread that
  // filters out undefined values.
  const patch: TenantInvoiceSettingsPatch = {
    ...(input.currencyCode !== undefined && { currencyCode: input.currencyCode }),
    ...(input.vatRate !== undefined && { vatRate: input.vatRate }),
    ...(input.registrationFeeSatang !== undefined && {
      registrationFeeSatang: input.registrationFeeSatang,
    }),
    ...(input.legalNameTh !== undefined && { legalNameTh: input.legalNameTh }),
    ...(input.legalNameEn !== undefined && { legalNameEn: input.legalNameEn }),
    ...(input.taxId !== undefined && { taxId: input.taxId }),
    ...(input.registeredAddressTh !== undefined && {
      registeredAddressTh: input.registeredAddressTh,
    }),
    ...(input.registeredAddressEn !== undefined && {
      registeredAddressEn: input.registeredAddressEn,
    }),
    ...(input.invoiceNumberPrefix !== undefined && {
      invoiceNumberPrefix: input.invoiceNumberPrefix,
    }),
    ...(input.creditNoteNumberPrefix !== undefined && {
      creditNoteNumberPrefix: input.creditNoteNumberPrefix,
    }),
    ...(input.receiptNumberPrefix !== undefined && {
      receiptNumberPrefix: input.receiptNumberPrefix,
    }),
    ...(input.receiptNumberingMode !== undefined && {
      receiptNumberingMode: input.receiptNumberingMode,
    }),
    ...(input.fiscalYearStartMonth !== undefined && {
      fiscalYearStartMonth: input.fiscalYearStartMonth,
    }),
    ...(input.defaultNetDays !== undefined && { defaultNetDays: input.defaultNetDays }),
    ...(input.proRatePolicy !== undefined && { proRatePolicy: input.proRatePolicy }),
    ...(input.autoEmailEnabled !== undefined && { autoEmailEnabled: input.autoEmailEnabled }),
    ...(input.logoBlobKey !== undefined && { logoBlobKey: input.logoBlobKey }),
  };

  if (Object.keys(patch).length === 0) return err({ code: 'no_op' });

  // Audit with the patch shape so reviewers can reconstruct any
  // change. `registrationFeeSatang` is a bigint — serialise as string
  // so the JSON round-trip is safe.
  const auditPayload: Record<string, unknown> = { ...patch };
  if (auditPayload.registrationFeeSatang !== undefined) {
    auditPayload.registrationFeeSatang = String(auditPayload.registrationFeeSatang);
  }

  // N1 (review 2026-04-19 21:19) — upsert + audit MUST share a single
  // transaction so an audit failure rolls back the settings write.
  // Violation would breach Constitution v1.4.0 Principle I clause 4
  // (audit-in-same-tx, NON-NEGOTIABLE).
  await deps.tenantSettingsRepo.withTx(input.tenantId, async (tx) => {
    await deps.tenantSettingsRepo.upsert(input.tenantId, patch, tx);
    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      eventType: 'tenant_invoice_settings_updated',
      actorUserId: input.actorUserId,
      summary: `Tenant invoice settings updated (${Object.keys(patch).length} field${
        Object.keys(patch).length === 1 ? '' : 's'
      })`,
      payload: auditPayload,
    });
  });

  return ok(undefined);
}
