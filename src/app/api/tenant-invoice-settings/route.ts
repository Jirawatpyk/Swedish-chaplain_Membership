/**
 * R7-B2 — PATCH /api/tenant-invoice-settings (F4 US4 / FR-009).
 *
 * JSON body accepting any subset of the settings fields. First write
 * creates the row (which then unlocks issuance per FR-010); subsequent
 * writes patch only the provided fields.
 *
 * Admin-only. Manager is read-only on finance per FR-012.
 *
 * Body shape mirrors the snake_case DB column names:
 *
 *   {
 *     vat_rate?: string (4-dp decimal, e.g. "0.0700")
 *     registration_fee_satang?: string (bigint)
 *     legal_name_th?: string
 *     legal_name_en?: string
 *     tax_id?: string (13 digits)
 *     registered_address_th?: string
 *     registered_address_en?: string
 *     invoice_number_prefix?: string
 *     credit_note_number_prefix?: string
 *     receipt_number_prefix?: string | null
 *     receipt_numbering_mode?: "combined" | "separate"
 *     fiscal_year_start_month?: number (1-12)
 *     default_net_days?: number (0-365)
 *     pro_rate_policy?: "none" | "monthly" | "daily"
 *     auto_email_enabled?: boolean
 *     logo_blob_key?: string | null
 *   }
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  updateTenantInvoiceSettings,
  makeUpdateTenantInvoiceSettingsDeps,
} from '@/modules/invoicing';
import { logger } from '@/lib/logger';

// Body shape — snake_case for HTTP wire; mapped to camelCase use-case
// input below. All fields optional (PATCH semantics).
const bodySchema = z.object({
  vat_rate: z.string().optional(),
  registration_fee_satang: z.string().optional(),
  legal_name_th: z.string().optional(),
  legal_name_en: z.string().optional(),
  tax_id: z.string().optional(),
  registered_address_th: z.string().optional(),
  registered_address_en: z.string().optional(),
  invoice_number_prefix: z.string().optional(),
  credit_note_number_prefix: z.string().optional(),
  receipt_number_prefix: z.string().nullable().optional(),
  receipt_numbering_mode: z.enum(['combined', 'separate']).optional(),
  fiscal_year_start_month: z.number().int().optional(),
  default_net_days: z.number().int().optional(),
  pro_rate_policy: z.enum(['none', 'monthly', 'daily']).optional(),
  auto_email_enabled: z.boolean().optional(),
  logo_blob_key: z.string().nullable().optional(),
});

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'write' });
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: 'invalid_json' } }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'invalid_body', details: parsed.error.flatten() } },
      { status: 400 },
    );
  }

  const b = parsed.data;
  const result = await updateTenantInvoiceSettings(makeUpdateTenantInvoiceSettingsDeps(), {
    tenantId: tenantCtx.slug,
    actorUserId: ctx.current.user.id,
    requestId,
    ...(b.vat_rate !== undefined && { vatRate: b.vat_rate }),
    ...(b.registration_fee_satang !== undefined && {
      registrationFeeSatang: BigInt(b.registration_fee_satang),
    }),
    ...(b.legal_name_th !== undefined && { legalNameTh: b.legal_name_th }),
    ...(b.legal_name_en !== undefined && { legalNameEn: b.legal_name_en }),
    ...(b.tax_id !== undefined && { taxId: b.tax_id }),
    ...(b.registered_address_th !== undefined && { registeredAddressTh: b.registered_address_th }),
    ...(b.registered_address_en !== undefined && { registeredAddressEn: b.registered_address_en }),
    ...(b.invoice_number_prefix !== undefined && { invoiceNumberPrefix: b.invoice_number_prefix }),
    ...(b.credit_note_number_prefix !== undefined && {
      creditNoteNumberPrefix: b.credit_note_number_prefix,
    }),
    ...(b.receipt_number_prefix !== undefined && { receiptNumberPrefix: b.receipt_number_prefix }),
    ...(b.receipt_numbering_mode !== undefined && {
      receiptNumberingMode: b.receipt_numbering_mode,
    }),
    ...(b.fiscal_year_start_month !== undefined && {
      fiscalYearStartMonth: b.fiscal_year_start_month,
    }),
    ...(b.default_net_days !== undefined && { defaultNetDays: b.default_net_days }),
    ...(b.pro_rate_policy !== undefined && { proRatePolicy: b.pro_rate_policy }),
    ...(b.auto_email_enabled !== undefined && { autoEmailEnabled: b.auto_email_enabled }),
    ...(b.logo_blob_key !== undefined && { logoBlobKey: b.logo_blob_key }),
  });

  if (!result.ok) {
    if (result.error.code === 'vat_rate_out_of_range') {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    if (result.error.code === 'no_op') {
      return NextResponse.json({ error: { code: 'no_op' } }, { status: 400 });
    }
    logger.warn({ err: result.error, tenantSlug: tenantCtx.slug }, 'tenant settings update failed');
    return NextResponse.json({ error: { code: 'server_error' } }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
