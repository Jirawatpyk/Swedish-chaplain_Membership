/**
 * GET /api/members/[memberId]/invoices — US7 AS1 / FR-032.
 *
 * Lists every invoice for the given member (all statuses, drafts
 * included) so the F3 member detail page's Invoices section can
 * render a complete billing history.
 *
 * RBAC: admin + manager (read-only). `member` role is NOT permitted
 * here — members use `/api/portal/invoices` scoped to their own
 * company. F4 kill-switch gating lives in `src/proxy.ts`.
 *
 * Security: the route verifies the member exists in the current
 * tenant BEFORE invoking the invoice query. An unknown UUID returns
 * 404 and emits `member_cross_tenant_probe` (Constitution Principle I
 * clause 4) — otherwise the route would leak member-row existence
 * across tenants via the 200-vs-404 oracle.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { getMember, type MemberId } from '@/modules/members';
import { buildMemberProbeDeps } from '@/modules/members/members-deps';
import {
  listInvoicesByMember,
  listInvoicesByMemberSchema,
  makeListInvoicesByMemberDeps,
} from '@/modules/invoicing';
import { serialiseInvoice } from '../../../invoices/_serialise';

const paramsSchema = z.object({
  memberId: z.string().uuid(),
});

const querySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  status: z
    .enum(['draft', 'issued', 'paid', 'void', 'credited', 'partially_credited', 'all'])
    .optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'invoice',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const resolved = await params;
  const paramsParsed = paramsSchema.safeParse(resolved);
  if (!paramsParsed.success) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Member not found.' } },
      { status: 404 },
    );
  }

  const url = new URL(request.url);
  const queryParsed = querySchema.safeParse({
    pageSize: url.searchParams.get('pageSize') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
  });
  if (!queryParsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_query',
          message: 'Invalid query parameters.',
          details: queryParsed.error.flatten(),
        },
      },
      { status: 400 },
    );
  }

  const tenantCtx = resolveTenantFromRequest(request);

  // Existence + tenant-scope probe. `getMember` already emits
  // `member_cross_tenant_probe` on miss — reuse it rather than adding
  // a second probe site for the same decision. Use the minimal
  // probe-deps factory to avoid allocating the full F3 deps bag on
  // every invoice-list request.
  const probeDeps = buildMemberProbeDeps(tenantCtx);
  const memberResult = await getMember(
    paramsParsed.data.memberId as MemberId,
    { actorUserId: ctx.current.user.id, requestId: ctx.requestId },
    probeDeps,
  );
  if (!memberResult.ok) {
    if (memberResult.error.type === 'not_found') {
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Member not found.' } },
        { status: 404 },
      );
    }
    // Log only the discriminated error-type tag — pino serialises a
    // raw `cause: unknown` which may spill infra paths + stack traces
    // into log storage. The Result tag is enough for correlation.
    logger.error(
      { requestId: ctx.requestId, errType: memberResult.error.type },
      'member-invoices: member lookup failed',
    );
    return NextResponse.json(
      { error: { code: 'server_error', message: 'Internal server error.' } },
      { status: 500 },
    );
  }

  const input = listInvoicesByMemberSchema.parse({
    tenantId: tenantCtx.slug,
    memberId: paramsParsed.data.memberId,
    pageSize: queryParsed.data.pageSize,
    offset: queryParsed.data.offset,
    ...(queryParsed.data.status !== undefined
      ? { status: queryParsed.data.status }
      : {}),
  });

  const result = await listInvoicesByMember(
    makeListInvoicesByMemberDeps(tenantCtx.slug),
    input,
  );

  if (!result.ok) {
    // Log only the discriminated error-type tag (same reasoning as
    // the member-probe log above).
    logger.error(
      { requestId: ctx.requestId, errType: result.error.type },
      'list-invoices-by-member: unhandled',
    );
    return NextResponse.json(
      { error: { code: 'server_error', message: 'Internal server error.' } },
      { status: 500 },
    );
  }

  return NextResponse.json({
    rows: result.value.rows.map(serialiseInvoice),
    total: result.value.total,
  });
}
