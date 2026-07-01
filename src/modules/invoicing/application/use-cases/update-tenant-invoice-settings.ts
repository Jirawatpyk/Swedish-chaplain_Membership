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
import { asSatang } from '@/lib/money';
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
  // 088 T008 (F.5) — combined-numbering mode is RETIRED: the pre-payment bill
  // carries a non-§87 `SC` number, so the payment-time §86/4 receipt can never
  // reuse a §87 number from it. Only `'separate'` is accepted now (fail-closed);
  // a `'combined'` PATCH is rejected. The read type keeps the historical union
  // for legacy rows, but no new `'combined'` value can be written.
  receiptNumberingMode: z.enum(['separate']).optional(),
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
      // F5R3 H-5 (2026-05-16) — brand at HTTP-boundary update.
      registrationFeeSatang: asSatang(input.registrationFeeSatang),
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
    // Round-3 fix R3-H1 — read priorSettings INSIDE the tx with
    // `SELECT … FOR UPDATE` so a concurrent admin save cannot flip
    // the prefix between read + upsert. Without the lock the §87
    // forensic-trail audit could record the wrong "old" value (e.g.
    // P1 reads INV, P2 reads INV, P1 writes AAA, P2 writes BBB →
    // P2's audit says "old=INV → new=BBB" when on-disk truth was
    // "INV → AAA → BBB"). Null on first-time bootstrap.
    const priorSettings = await deps.tenantSettingsRepo.getForUpdateInTx(
      tx,
      input.tenantId,
    );

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

    // §87 forensic trail — emit a SEPARATE event when any document-
    // number prefix flips on a tenant that already has prior settings.
    // First-time bootstrap (priorSettings === null) is NOT a flip —
    // there's no "old" value to compare against.
    if (priorSettings !== null) {
      const changedPrefixes: Record<
        string,
        { old: string | null; new: string | null }
      > = {};
      if (
        input.invoiceNumberPrefix !== undefined &&
        input.invoiceNumberPrefix !== priorSettings.invoiceNumberPrefix
      ) {
        changedPrefixes.invoice_number_prefix = {
          old: priorSettings.invoiceNumberPrefix,
          new: input.invoiceNumberPrefix,
        };
      }
      if (
        input.creditNoteNumberPrefix !== undefined &&
        input.creditNoteNumberPrefix !== priorSettings.creditNoteNumberPrefix
      ) {
        changedPrefixes.credit_note_number_prefix = {
          old: priorSettings.creditNoteNumberPrefix,
          new: input.creditNoteNumberPrefix,
        };
      }
      if (
        input.receiptNumberPrefix !== undefined &&
        input.receiptNumberPrefix !== (priorSettings.receiptNumberPrefix ?? null)
      ) {
        // Round-3 fix R3-HIGH1 — preserve null fidelity. Previously
        // `?? ''` coerced an explicit null (combined-mode = no
        // separate receipt prefix) to empty string in the audit
        // payload, breaking the RD auditor's ability to distinguish
        // "explicit nullification" from "set to empty string".
        changedPrefixes.receipt_number_prefix = {
          old: priorSettings.receiptNumberPrefix ?? null,
          new: input.receiptNumberPrefix ?? null,
        };
      }

      if (Object.keys(changedPrefixes).length > 0) {
        // Round-3 fix R3-C1 — payload now matches the migration 0145
        // contract: includes `last_sequences` (per-doc-type last seq
        // used under the OLD prefix, derived from
        // `tenant_document_sequences.next_sequence_number - 1`) so
        // the RD forensic SELECT can reconstruct "where did the old
        // prefix stop?" without joining external tables.
        //
        // Round-4 fix R4-RD-H1 — `last_sequences` semantics:
        //   - [] (empty array) ⇒ tenant has NEVER issued any document
        //     under the old prefix (pre-issue tenant). The prefix-
        //     change audit row is still emitted so the §87 forensic
        //     trail captures the rename, but there is no "where did
        //     the old prefix stop?" anchor because nothing was issued
        //     yet.
        //   - [{ last_sequence_number: 0, ... }] ⇒ the row exists in
        //     `tenant_document_sequences` (lazy-allocated by the
        //     fiscal-year init path) but no INSERT has consumed it
        //     yet. Treat the same as "no documents issued" for the
        //     given (document_type, fiscal_year).
        //   - [{ last_sequence_number: N>0, ... }] ⇒ N documents have
        //     been issued under the OLD prefix; the next document
        //     under the NEW prefix will be sequence N+1.
        // RD auditor SQL should LEFT JOIN this array against
        // `audit_log` rows of type `invoice_issued` / `credit_note_issued`
        // / `invoice_paid` to verify the boundary.
        const sequences = await deps.tenantSettingsRepo.readSequencesInTx(
          tx,
          input.tenantId,
        );
        const lastSequences = sequences.map((s) => ({
          document_type: s.documentType,
          fiscal_year: s.fiscalYear,
          last_sequence_number: Math.max(0, s.nextSequenceNumber - 1),
        }));

        await deps.audit.emit(tx, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'tenant_receipt_prefix_changed',
          actorUserId: input.actorUserId,
          summary: `Tenant document-number prefix(es) changed: ${Object.keys(changedPrefixes).join(', ')}`,
          payload: {
            changed_prefixes: changedPrefixes,
            receipt_numbering_mode:
              input.receiptNumberingMode ?? priorSettings.receiptNumberingMode,
            last_sequences: lastSequences,
          },
        });
      }
    }
  });

  return ok(undefined);
}
