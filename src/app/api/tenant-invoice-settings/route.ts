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
import { rateLimiter } from '@/lib/auth-deps';
import {
  updateTenantInvoiceSettings,
  makeUpdateTenantInvoiceSettingsDeps,
} from '@/modules/invoicing';
// Direct infra import for GET — same escape-hatch pattern used by
// /admin/settings/invoicing/page.tsx (SSR read). Keeps GET a thin
// projection over the repo without a trivial use-case wrapper.
// eslint-disable-next-line no-restricted-imports
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { makeF4AuditPort } from '@/modules/invoicing';

// N4 (review 2026-04-19 21:19) — strict per-field constraints at the
// route boundary. Matches `updateTenantInvoiceSettingsSchema` in the
// use-case. Previously all fields were unbounded `z.string().optional()`
// which let oversized / malformed values reach the DB and audit
// payload. CLAUDE.md § "zod validates every system boundary".
const bodySchema = z.object({
  currency_code: z
    .string()
    .regex(/^[A-Z]{3}$/, 'currency_code must be 3 uppercase letters (ISO 4217)')
    .optional(),
  vat_rate: z
    .string()
    .regex(/^(?:0|[1-9]\d*)\.\d{4}$/, 'vat_rate must be 4-dp decimal (e.g. 0.0700)')
    .optional(),
  registration_fee_satang: z
    .string()
    .regex(/^\d{1,19}$/, 'registration_fee_satang must be a non-negative integer string')
    .optional(),
  legal_name_th: z.string().min(1).max(300).optional(),
  legal_name_en: z.string().min(1).max(300).optional(),
  tax_id: z
    .string()
    .regex(/^\d{13}$/, 'tax_id must be 13 digits (Thai RD format)')
    .optional(),
  registered_address_th: z.string().min(1).max(1000).optional(),
  registered_address_en: z.string().min(1).max(1000).optional(),
  invoice_number_prefix: z.string().min(1).max(20).optional(),
  credit_note_number_prefix: z.string().min(1).max(20).optional(),
  receipt_number_prefix: z.string().min(1).max(20).nullable().optional(),
  receipt_numbering_mode: z.enum(['combined', 'separate']).optional(),
  fiscal_year_start_month: z.number().int().min(1).max(12).optional(),
  default_net_days: z.number().int().min(0).max(365).optional(),
  pro_rate_policy: z.enum(['none', 'monthly', 'daily']).optional(),
  auto_email_enabled: z.boolean().optional(),
  // N7 — server-side cross-tenant guard on logo_blob_key. The route
  // handler additionally asserts the tenantId prefix matches the
  // actor's resolved tenant (below). Without this a malicious PATCH
  // could embed another tenant's logo into this tenant's identity
  // snapshot. `.null` also accepted to clear the logo.
  logo_blob_key: z
    .string()
    .max(500)
    .regex(
      /^invoicing\/[A-Za-z0-9_-]+\/logos\/[A-Za-z0-9_-]+\.(png|jpg)$/,
      'logo_blob_key must match invoicing/<tenantId>/logos/<name>.{png|jpg}',
    )
    .nullable()
    .optional(),
});

/**
 * T094 — GET /api/tenant-invoice-settings (F4 US4 / FR-009).
 *
 * Returns the current settings snapshot in the same snake_case shape
 * as PATCH accepts. `null` body (HTTP 200) signals "not yet
 * bootstrapped" so the admin UI renders the FR-010 empty-state.
 * Admin-only (manager is read-only on finance per FR-012; a manager
 * GET is allowed — read-only — in a later revision when the UI grows
 * a read-only view).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'tenant_invoice_settings',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);
  const view = await drizzleTenantSettingsRepo.getForIssue(tenantCtx.slug);

  if (!view) {
    return NextResponse.json({ settings: null }, { status: 200 });
  }

  return NextResponse.json(
    {
      settings: {
        tenant_id: view.tenantId,
        currency_code: view.currencyCode,
        vat_rate: view.vatRate.raw,
        registration_fee_satang: String(view.registrationFeeSatang),
        legal_name_th: view.identity.legal_name_th,
        legal_name_en: view.identity.legal_name_en,
        tax_id: view.identity.tax_id,
        registered_address_th: view.identity.address_th,
        registered_address_en: view.identity.address_en,
        invoice_number_prefix: view.invoiceNumberPrefix,
        credit_note_number_prefix: view.creditNoteNumberPrefix,
        receipt_number_prefix: view.receiptNumberPrefix ?? null,
        receipt_numbering_mode: view.receiptNumberingMode,
        fiscal_year_start_month: view.fiscalYearStartMonth,
        default_net_days: view.defaultNetDays,
        pro_rate_policy: view.proRatePolicy,
        auto_email_enabled: view.autoEmailEnabled,
        logo_blob_key: view.identity.logo_blob_key ?? null,
      },
    },
    { status: 200 },
  );
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'tenant_invoice_settings',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  // T120 — Host-header / session-bound-tenant dual-bind probe.
  //
  // `resolveTenantFromRequest` currently hard-codes to `env.tenant.slug`
  // (STD deployment), so this check is dormant today. When F10 MTA
  // rolls out and the resolver starts parsing subdomain / session
  // claims, a mismatch between the host-header-resolved tenant and the
  // deployment-bound tenant signals either (a) an MTA misconfiguration
  // or (b) a deliberate cross-tenant probe by an attacker with a valid
  // admin session on a different tenant. Either way: audit + 403.
  //
  // We compare against `env.tenant.slug` rather than a session-bound
  // tenant claim because F1 `UserAccount` does not carry a `tenantId`
  // field (sessions are cross-tenant by design — membership is via
  // `contacts.linked_user_id`). The env-bound slug IS the
  // authoritative deployed tenant for STD; for MTA this comparison
  // evolves to a session-claim check without needing a route-handler
  // rewrite.
  if (tenantCtx.slug !== env.tenant.slug) {
    logger.warn(
      {
        requestId,
        hostResolvedSlug: tenantCtx.slug,
        deployedSlug: env.tenant.slug,
        userId: ctx.current.user.id,
      },
      'PATCH /api/tenant-invoice-settings host / deployed-tenant mismatch',
    );
    await makeF4AuditPort().emit(null, {
      tenantId: tenantCtx.slug,
      requestId,
      eventType: 'tenant_invoice_settings_cross_tenant_probe',
      actorUserId: ctx.current.user.id,
      summary: `Cross-tenant probe on tenant-invoice-settings (host=${tenantCtx.slug}, deployed=${env.tenant.slug})`,
      payload: {
        host_resolved_slug: tenantCtx.slug,
        deployed_slug: env.tenant.slug,
        route: 'PATCH /api/tenant-invoice-settings',
      },
    });
    return NextResponse.json(
      { error: { code: 'cross_tenant_forbidden' } },
      { status: 403 },
    );
  }

  // N5 — rate-limit. Settings mutation is high-value (legal identity
  // snapshots into every future invoice) + feeds an audit emit on
  // every call. 30 / min matches the admin-mutation norm.
  const rl = await rateLimiter.check(
    `f4:settings:${tenantCtx.slug}:${ctx.current.user.id}`,
    30,
    60,
  );
  if (!rl.success) {
    logger.warn(
      { requestId, tenantId: tenantCtx.slug, userId: ctx.current.user.id, reset: rl.reset },
      'PATCH /api/tenant-invoice-settings rate-limited',
    );
    return NextResponse.json(
      { error: { code: 'rate_limited', retryAfterMs: rl.reset - Date.now() } },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rl.reset - Date.now()) / 1000)) },
      },
    );
  }

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

  // N7 — cross-tenant guard on logo_blob_key. The regex above ensures
  // shape; here we assert the encoded tenantId matches the caller's
  // resolved tenant so one tenant cannot reference another's logo.
  if (b.logo_blob_key !== undefined && b.logo_blob_key !== null) {
    const expectedPrefix = `invoicing/${tenantCtx.slug}/logos/`;
    if (!b.logo_blob_key.startsWith(expectedPrefix)) {
      logger.warn(
        { tenantSlug: tenantCtx.slug, userId: ctx.current.user.id, requestId },
        'PATCH /api/tenant-invoice-settings logo_blob_key tenant-prefix mismatch',
      );
      return NextResponse.json(
        { error: { code: 'invalid_logo_key' } },
        { status: 400 },
      );
    }
  }

  const result = await updateTenantInvoiceSettings(makeUpdateTenantInvoiceSettingsDeps(), {
    tenantId: tenantCtx.slug,
    actorUserId: ctx.current.user.id,
    requestId,
    ...(b.currency_code !== undefined && { currencyCode: b.currency_code }),
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
