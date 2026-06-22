/**
 * GET `/api/admin/members/search?q=…&limit=…`
 *
 * Lightweight member-autocomplete endpoint backing the F6 Phase 9
 * relink dialog (US6 / T106) and any future admin surface that needs
 * a fuzzy member picker. Distinct from `/api/plans/search` (which
 * returns the full command-palette payload: plans + members +
 * refundable invoices) — keeps the dialog's wire-shape minimal so the
 * picker stays fast.
 *
 * Authz: admin or manager (both roles get read access to the member
 * directory per F3 RBAC; write actions are gated separately at the
 * action endpoint, e.g. POST /relink which is admin-only).
 *
 * Responses:
 *   200 OK   { items: [{ memberId, companyName, primaryContactName | null }] }
 *   400 BAD  invalid query (empty `q`, oversized `limit`, …)
 *   401/403  via `requireAdminContext` (re-uses the same gate as the
 *            plans-search palette endpoint)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { directorySearch } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';

export const runtime = 'nodejs';

const querySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Use 'member' read action because both admin AND manager can search
  // the directory; the relink action endpoint enforces admin-only on
  // its own (POST /relink). Mirrors /api/plans/search auth pattern.
  const ctx = await requireAdminContext(request, {
    resource: 'member',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    q: url.searchParams.get('q') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_query',
          message: 'Invalid query parameters.',
          details: { issues: parsed.error.issues },
        },
      },
      { status: 400 },
    );
  }

  const tenant = resolveTenantFromRequest(request);
  const deps = buildMembersDeps(tenant);

  const result = await directorySearch(
    { tenant: deps.tenant, memberRepo: deps.memberRepo },
    {
      q: parsed.data.q,
      limit: parsed.data.limit ?? 10,
    },
  );

  if (!result.ok) {
    logger.error(
      { requestId: ctx.requestId, err: result.error },
      'admin-members-search: server error',
    );
    return NextResponse.json(
      { error: { code: 'server_error', message: 'Internal server error.' } },
      { status: 500 },
    );
  }

  const items = result.value.items.map((row) => ({
    memberId: row.member.memberId,
    companyName: row.member.companyName,
    primaryContactName: row.primaryContact
      ? `${row.primaryContact.firstName} ${row.primaryContact.lastName}`.trim()
      : null,
    // Boolean presence check: the Contact domain type guarantees `email` is
    // a branded Email string (never empty string) when primaryContact exists,
    // so a falsy-coercion is sufficient — no string-length check needed.
    hasPrimaryContactEmail: Boolean(row.primaryContact?.email),
  }));

  return NextResponse.json({ items }, { status: 200 });
}
