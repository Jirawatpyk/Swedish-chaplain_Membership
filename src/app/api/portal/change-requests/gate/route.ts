/**
 * F114 — `GET /api/portal/change-requests/gate` (US1; contracts/portal-
 * change-requests-api.md § 1). How the caller's edits will be handled:
 *
 *   { mode: 'approval' | 'immediate', canProposeCompanyFields, pending }
 *
 * `canProposeCompanyFields` = the caller's contact `is_primary` (FR-002);
 * `pending` = the caller's OWN pending request (never another contact's),
 * compact — the form only needs to know it exists and what it covers. With
 * the gate `immediate` the pending read is skipped: there is nothing to show.
 * 404 while the platform flag is off (FR-039).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { requireMemberContext } from '@/lib/member-context';
import { asMembersUserId, buildChangeRequestDeps } from '@/lib/members-change-request-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ERROR_ID = 'M114.portal.gate';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!env.features.memberChangeApproval) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;

  const deps = buildChangeRequestDeps(ctx.tenant);

  let mode: 'immediate' | 'approval';
  try {
    mode = await deps.memberChangeGate.resolve(ctx.tenant);
  } catch (e) {
    logger.error(
      { errorId: `${ERROR_ID}.gate_failed`, requestId: ctx.requestId, tenantId: ctx.tenant.slug, err: errKind(e) },
      'change-requests.gate: gate resolver failed',
    );
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  const canProposeCompanyFields = ctx.ownContact.isPrimary;
  if (mode === 'immediate') {
    return NextResponse.json({ mode, canProposeCompanyFields, pending: null });
  }

  const pending = await runInTenant(ctx.tenant, (tx) =>
    deps.changeRequestRepo.findPendingBySubmitterInTx(tx, asMembersUserId(ctx.current.user.id)),
  ).catch((e: unknown) => ({ ok: false as const, error: { code: 'repo.unexpected' as const, cause: e } }));
  if (!pending.ok) {
    logger.error(
      { errorId: `${ERROR_ID}.pending_read_failed`, requestId: ctx.requestId, tenantId: ctx.tenant.slug, err: pending.error.code },
      'change-requests.gate: pending read failed',
    );
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  return NextResponse.json({
    mode,
    canProposeCompanyFields,
    pending:
      pending.value === null
        ? null
        : {
            id: pending.value.id,
            submittedAt: pending.value.submittedAt.toISOString(),
            fieldKeys: pending.value.fields.map((f) => f.key),
          },
  });
}
