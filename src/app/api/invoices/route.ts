/**
 * T052 — GET /api/invoices (list) + POST /api/invoices (create draft).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { addMonthsUtc } from '@/lib/dates';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import {
  createInvoiceDraft,
  createInvoiceDraftSchema,
  listInvoices,
  listInvoicesSchema,
  makeCreateInvoiceDraftDeps,
  makeListInvoicesDeps,
  type CreateInvoiceDraftInput,
} from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { serialiseInvoice } from './_serialise';
import { loadMemberRenewalContext } from '@/app/(staff)/admin/invoices/_lib/member-renewal-context';

/**
 * First day of the CURRENT Bangkok month as a naive UTC-midnight ISO stamp
 * (`YYYY-MM-01T00:00:00.000Z`) — the SAME month-start basis the renewal
 * settlement core stores anchors on (`paymentAnchorMonthStartUtc`), so the
 * "has this cycle's period already expired at issue time?" check compares
 * like-for-like against a stored `period_to`. Used only for the first-payment
 * comeback carve-out in POST below.
 */
function currentBangkokMonthStartUtc(): string {
  const today = bangkokLocalDate(new Date().toISOString()); // YYYY-MM-DD (Bangkok)
  return `${today.slice(0, 7)}-01T00:00:00.000Z`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'read' });
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);
  const url = new URL(request.url);
  const raw: Record<string, string | number | boolean> = {};
  for (const [k, v] of url.searchParams.entries()) raw[k] = v;

  const parsed = listInvoicesSchema.safeParse({
    tenantId: tenantCtx.slug,
    cursor: raw.cursor,
    pageSize: raw.pageSize ? Number(raw.pageSize) : 50,
    status: raw.status,
    fiscalYear: raw.fiscalYear ? Number(raw.fiscalYear) : undefined,
    memberId: raw.memberId,
    search: raw.search,
    includeDrafts: raw.includeDrafts === 'true',
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'invalid_query', details: parsed.error.flatten() } },
      { status: 400 },
    );
  }

  const result = await listInvoices(makeListInvoicesDeps(tenantCtx.slug), parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: { code: 'server_error' } }, { status: 500 });
  }
  return NextResponse.json({
    rows: result.value.rows.map(serialiseInvoice),
    next_cursor: result.value.nextCursor,
  });
}

const createBodySchema = z.object({
  member_id: z.string().uuid(),
  plan_id: z.string().min(1),
  plan_year: z.number().int(),
  auto_email_on_issue: z.boolean().nullable().optional(),
  /**
   * Deliberate-duplicate acknowledgement. A member CAN legitimately hold two
   * live membership invoices in the same plan year — this is the one surface
   * where that is a decision a human is allowed to make, so the refusal is
   * overridable here and nowhere else (the renewal/automated paths refuse
   * hard with no override; a duplicate there is always a bug).
   *
   * `z.literal(true)` — the ONLY accepted value is the JSON boolean `true`.
   * A string `"true"`, `1`, `"1"` or any other truthy value is a 400, so the
   * override cannot be set by a coercion accident or smuggled through a
   * form/query encoding. There is no default-on path: absent means refuse.
   *
   * The client may only send it after the admin has SEEN the existing
   * invoice's details (see the duplicate-confirmation dialog in
   * `invoice-form.tsx`) — the point is an informed decision, not a reflexive
   * click-through.
   */
  acknowledge_duplicate: z.literal(true).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
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
  const parsed = createBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'invalid_body', details: parsed.error.flatten() } },
      { status: 400 },
    );
  }

  // Task 9 (renewal-rolling-anchor §3b review-mandate) — server-authoritative
  // coverage window: the client NEVER supplies `membershipCoverage` (it's a
  // printed §86/4 tax-document field). Resolve the SAME classification the
  // New-invoice form's advisory context line used, and thread the window from
  // the member's OPEN cycle. A lookup failure degrades to the `from_payment`
  // default rather than blocking draft creation (advisory-only per design).
  //   - RENEWAL bills the NEXT period `[periodTo, periodTo + term)`.
  //   - 064: a FIRST payment (or any member with an open cycle) bills the
  //     CURRENT period `[currentPeriodFrom, currentPeriodTo)` — so an imported
  //     member's first §86/4 prints their real membership dates, not the generic
  //     "12 months from payment" wording (which regressed in PR #173) — UNLESS
  //     that current period has ALREADY expired (see the comeback carve-out
  //     below).
  let membershipCoverage: CreateInvoiceDraftInput['membershipCoverage'];
  try {
    const renewalContext = await loadMemberRenewalContext(tenantCtx.slug, parsed.data.member_id);
    if (
      renewalContext.classification.kind === 'renewal' &&
      renewalContext.periodTo !== null &&
      renewalContext.termMonths !== null
    ) {
      membershipCoverage = {
        kind: 'window',
        fromIso: renewalContext.periodTo,
        toIso: addMonthsUtc(renewalContext.periodTo, renewalContext.termMonths),
      };
    } else if (
      renewalContext.currentPeriodFrom &&
      renewalContext.currentPeriodTo &&
      // FIXED-ANCHOR comeback carve-out (2026-07-22) — only print the cycle's
      // CURRENT period as the concrete §86/4 window while it is still live. If
      // it has ALREADY expired by the current Bangkok month, paying this bill
      // triggers the settlement comeback exception (reanchor-first-payment.ts),
      // which re-anchors to the PAYMENT month — so the dead past window would
      // contradict the receipt. Fall through to the `from_payment` default
      // ("12 months, effective from the month of payment"): the honest wording
      // when the real anchor is only fixed at payment time. The month-start
      // basis mirrors the core's comeback comparison (`periodTo <= payment
      // month`), using THIS month as the best proxy for the (unknown) payment
      // month at issue time.
      Date.parse(renewalContext.currentPeriodTo) > Date.parse(currentBangkokMonthStartUtc())
    ) {
      membershipCoverage = {
        kind: 'window',
        fromIso: renewalContext.currentPeriodFrom,
        toIso: renewalContext.currentPeriodTo,
      };
    }
  } catch (err) {
    logger.warn(
      { err, tenantSlug: tenantCtx.slug, memberId: parsed.data.member_id },
      '[invoices] member-renewal-context lookup failed at draft-create — falling back to from_payment coverage text',
    );
  }

  const input = createInvoiceDraftSchema.parse({
    tenantId: tenantCtx.slug,
    actorUserId: ctx.current.user.id,
    requestId,
    memberId: parsed.data.member_id,
    planId: parsed.data.plan_id,
    planYear: parsed.data.plan_year,
    autoEmailOnIssue: parsed.data.auto_email_on_issue ?? null,
    ...(membershipCoverage ? { membershipCoverage } : {}),
    // This route is the one INTERACTIVE membership-invoice surface — there is
    // a human here to ask — so it always opts into the duplicate check.
    // `'acknowledged'` only when the client sent the literal boolean `true`,
    // which the form does solely from the confirmation dialog after showing
    // the operator the existing document. Everything else is `'refuse'`.
    duplicatePolicy:
      parsed.data.acknowledge_duplicate === true ? ('acknowledged' as const) : ('refuse' as const),
  });

  const result = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenantCtx.slug), input);
  if (!result.ok) {
    // A duplicate refusal is a 409 that the client is EXPECTED to recover
    // from, so unlike every other error code it carries a detail body: the
    // admin has to see which document already exists (and be able to open it)
    // before deciding whether a second one is deliberate. Sending back only
    // `{ code }` here would reduce the confirmation dialog to a bare "are you
    // sure?", which is the reflexive click-through this guard exists to
    // prevent. No PII is added — an invoice id, its number, status and total
    // for a member the caller already named in the request body.
    if (result.error.code === 'duplicate_membership_invoice') {
      logger.warn(
        {
          tenantSlug: tenantCtx.slug,
          memberId: parsed.data.member_id,
          planYear: parsed.data.plan_year,
          existingInvoiceId: result.error.existingInvoiceId,
          existingStatus: result.error.existingStatus,
        },
        'invoice draft create refused — a live membership invoice already exists for this member and plan year',
      );
      return NextResponse.json(
        {
          error: {
            code: result.error.code,
            existing: {
              invoice_id: result.error.existingInvoiceId,
              status: result.error.existingStatus,
              document_number: result.error.existingDocumentNumber,
              // bigint is not JSON-serialisable — send satang as a string and
              // let the client format it (the same treatment money gets on
              // every other F4 wire surface).
              total_satang:
                result.error.existingTotalSatang === null
                  ? null
                  : String(result.error.existingTotalSatang),
            },
          },
        },
        { status: 409 },
      );
    }
    const status =
      result.error.code === 'settings_missing' || result.error.code === 'plan_not_found'
        ? 409
        : result.error.code === 'member_archived'
          ? 409
          : result.error.code === 'member_not_found'
            ? 404
            : 400;
    logger.warn({ err: result.error, tenantSlug: tenantCtx.slug }, 'invoice draft create failed');
    return NextResponse.json({ error: { code: result.error.code } }, { status });
  }
  return NextResponse.json(serialiseInvoice(result.value), { status: 201 });
}
