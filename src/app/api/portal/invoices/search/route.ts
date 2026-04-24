/**
 * T086 — GET /api/portal/invoices/search (F5 Group I).
 *
 * Member-only cmdk "Pay invoice" command palette backend.
 *
 * Contract:
 *   - Auth: member role only. 401 no-session / 403 staff.
 *   - Scope: invoices belonging to the caller's own `memberId`, filtered
 *     to `status === 'issued'` (issued + derived-overdue; skips
 *     paid/void/credited). Tenant isolation relies on the F4 repo
 *     running under `runInTenant` + RLS (defence-in-depth over the
 *     explicit `tenantId` filter).
 *   - Query: `q` — document-number substring (ILIKE %q%); max 64 chars.
 *   - Response: `{ invoices: [{ id, invoiceNumber, amountDue, currency }] }`
 *     capped at 20 rows to keep the palette snappy.
 *   - Rate limit: 30 req/min per member. Shares the same Upstash
 *     Ratelimit primitive F4 uses elsewhere.
 *
 * Proxy kill-switch: `/api/portal/invoices` is already gated by
 * `src/proxy.ts` when FEATURE_F4_INVOICING=false.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireMemberContext } from '@/lib/member-context';
import {
  listInvoicesByMember,
  makeListInvoicesByMemberDeps,
} from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { rateLimiter } from '@/lib/auth-deps';

const MAX_ROWS = 20;
const MAX_QUERY_LEN = 64;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;

  // 30 req/min window keyed per member. Cheap + plenty of headroom for
  // palette typing (cmdk fires once per keystroke post-debounce).
  const rl = await rateLimiter.check(
    `f5:cmdk:invoice-search:${ctx.tenant.slug}:${ctx.memberId}`,
    30,
    60,
  );
  if (!rl.success) {
    return NextResponse.json(
      { error: { code: 'rate_limited' } },
      {
        status: 429,
        headers: {
          'Retry-After': String(
            Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000)),
          ),
        },
      },
    );
  }

  const rawQ = request.nextUrl.searchParams.get('q') ?? '';
  const q = rawQ.trim().slice(0, MAX_QUERY_LEN);

  // Ordering note (F-02 fix): the underlying Drizzle
  // `InvoiceRepo.listPaged` orders by
  //   `desc(invoices.issueDate), desc(invoices.invoiceId)`
  // unconditionally, which satisfies the UX expectation "most recent
  // issued first". There is currently no `sortBy` parameter on the
  // Application use-case; if one is added later, palette callers MUST
  // pin `sortBy: 'issued_at'` + `sortDir: 'desc'` explicitly. The
  // contract-test asserts the newest invoice lands at index 0 so a
  // future refactor that changes the default is caught immediately.
  const result = await listInvoicesByMember(
    makeListInvoicesByMemberDeps(ctx.tenant.slug),
    {
      tenantId: ctx.tenant.slug,
      memberId: String(ctx.memberId),
      pageSize: MAX_ROWS,
      offset: 0,
      status: 'issued',
      ...(q.length > 0 ? { search: q } : {}),
    },
  );
  if (!result.ok) {
    logger.warn(
      {
        requestId: ctx.requestId,
        tenantId: ctx.tenant.slug,
        memberId: ctx.memberId,
      },
      'GET /api/portal/invoices/search failed',
    );
    return NextResponse.json(
      { error: { code: 'server_error' } },
      { status: 500 },
    );
  }

  // F-01 fix: `inv.total.satang` is a minor-unit bigint (e.g.
  // 5_350_000n satang = 53,500 THB). Convert to major-unit THB before
  // serializing so cmdk's fuzzy-value string contains "53500" (what a
  // member actually types) rather than "5350000".
  const invoices = result.value.rows.map((inv) => ({
    id: String(inv.invoiceId),
    invoiceNumber: inv.documentNumber ? String(inv.documentNumber) : '',
    amountDue: inv.total ? Number(inv.total.satang) / 100 : 0,
    currency: inv.currency,
  }));

  return NextResponse.json(
    { invoices },
    {
      status: 200,
      headers: {
        // cmdk is an interactive search — never cache; every keystroke
        // is a new query and stale results would confuse.
        'Cache-Control': 'no-store',
      },
    },
  );
}
