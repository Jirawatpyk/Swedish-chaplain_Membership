/**
 * 088 T065b (FR-031, ภ.พ.30 support) — admin tax-document registers page.
 *
 * A period view surfacing the registers an accountant needs for the monthly
 * Thai VAT return (ภ.พ.30):
 *   - the §86/4 RC tax-receipt register (output-VAT),
 *   - the §80/1(5) zero-rate sales list, and
 *   - the §105 RE receipt register (no-TIN sales — also standard-rated 7%).
 *
 * The page ALSO surfaces the period ภ.พ.30 output-VAT figure (§86/4 + §105,
 * combined) on every register view, so the reported total is never understated
 * (B2 review FINDING 1).
 *
 * Kept as a SEPARATE page (not a mode on the hot-path invoice list) so the
 * register — a distinct, period-scoped, RD-audit surface — carries zero
 * regression risk to the operational list. Admin-only + gated on
 * `FEATURE_088_TAX_AT_PAYMENT` (404 otherwise). The heavy lifting is the
 * `listTaxDocumentRegister` use-case (live-Neon integration-tested); this page
 * is a thin server render over its output, drawn by `renderTaxRegisterView`
 * (spec 122 US8c, on AURA; shared with the no-DB preview route).
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';

import { requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { listTaxDocumentRegister, makeListTaxDocumentRegisterDeps } from '@/modules/invoicing';
import { TableContainer } from '@/components/layout';
import { renderTaxRegisterView, type RegisterKind } from './_components/tax-register-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.invoices.registers.meta');
  return { title: t('title') };
}

// Shape only. A shape-valid but impossible date (`2026-02-30`) is passed
// through so the use-case refuses it as `invalid_range` / `not_a_date` rather
// than silently swapping in the default range.
const YMD = /^\d{4}-\d{2}-\d{2}$/;

interface SearchParams {
  readonly kind?: string;
  readonly from?: string;
  readonly to?: string;
}

/** Bangkok is UTC+7 (no DST). */
function todayBangkokYmd(): string {
  const d = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default async function TaxRegistersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePagePermission('invoicing.receipt');
  // The role half of this guard moved to `requirePagePermission` above; the
  // FLAG half stays — a flag-off tenant gets a clean 404 rather than an empty
  // surface, and that has nothing to do with who is asking.
  if (!env.features.f088TaxAtPayment) {
    notFound();
  }

  const query = await searchParams;
  const hdrs = await headers();
  const tenantCtx = resolveTenantFromHeaders(hdrs);

  const kind: RegisterKind =
    query.kind === 'zero_rate_sales'
      ? 'zero_rate_sales'
      : query.kind === 're_register'
        ? 're_register'
        : 'rc_register';
  const today = todayBangkokYmd();
  const from = query.from && YMD.test(query.from) ? query.from : `${today.slice(0, 8)}01`;
  const to = query.to && YMD.test(query.to) ? query.to : today;

  const result = await listTaxDocumentRegister(makeListTaxDocumentRegisterDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    kind,
    from,
    to,
  });

  return (
    <TableContainer>{await renderTaxRegisterView({ kind, from, to, result })}</TableContainer>
  );
}
