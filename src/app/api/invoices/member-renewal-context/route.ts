/**
 * Task 9 (renewal-rolling-anchor design 2026-07-08 §3b) —
 * GET /api/invoices/member-renewal-context?memberId=<uuid>
 *
 * Client-side fetch driven by the New-invoice form's member picker (mirrors
 * the F6 attendee-picker's fetch-on-select pattern): resolves the SAME
 * `classifyMembershipPayment` shape the payment-time settlement hooks
 * consume, so the form's context line + duplicate-billing warning describe
 * what will actually happen when this bill is paid. Advisory only — see
 * `../../../(staff)/admin/invoices/_lib/member-renewal-context.ts` docstring.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { loadMemberRenewalContext } from '@/app/(staff)/admin/invoices/_lib/member-renewal-context';

const querySchema = z.object({
  memberId: z.string().uuid(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'read' });
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({ memberId: url.searchParams.get('memberId') ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'invalid_query' } }, { status: 400 });
  }

  try {
    const context = await loadMemberRenewalContext(tenantCtx.slug, parsed.data.memberId);
    return NextResponse.json({
      classification: context.classification,
      period_to: context.periodTo,
      term_months: context.termMonths,
      has_unpaid_membership_invoice: context.hasUnpaidMembershipInvoice,
    });
  } catch (err) {
    // Advisory-only read (design §3b) — never surface a 500 that would make
    // the admin think the FORM is broken; log loudly and let the client
    // treat a non-200 as "no context available" (the panel simply hides).
    logger.warn(
      { err, tenantSlug: tenantCtx.slug, memberId: parsed.data.memberId },
      '[invoices] member-renewal-context lookup failed',
    );
    return NextResponse.json({ error: { code: 'lookup_failed' } }, { status: 500 });
  }
}
