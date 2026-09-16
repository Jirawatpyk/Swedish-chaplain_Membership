/**
 * F114 — `GET` + `PATCH /api/admin/settings/member-changes` — the per-tenant
 * approval switch (US6 AS2, AS4; contracts/admin-change-requests-api.md
 * § settings; FR-031, FR-032, FR-036, FR-038, FR-039).
 *
 * Platform flag OFF → 404 before any session work (dark ship — the flag is
 * the platform's layer, the setting the tenant's: flag first, then setting).
 * Gate: `requireApiPermission('members.write')` on BOTH verbs (a manager /
 * marketing user neither reads nor flips the switch — the settings card is
 * an admin surface). `PATCH` → in-route READ_ONLY_MODE 503 (T116) → zod body
 * `{ approvalEnabled: boolean }` (anything else → 400 problem `invalid_body`)
 * → `setMemberChangeApprovalEnabled` → 200 `{ approvalEnabled, changedAt }`
 * (`changedAt` null on the unchanged no-op — no audit row either). `GET` →
 * `{ approvalEnabled, pendingCount }` so the card can warn when switching
 * off with requests waiting (they stay decidable, FR-032). RFC 7807 problem
 * bodies on every error arm; every failing arm names itself:
 * `M114.admin.setting.<arm>`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { problemResponse } from '@/lib/http/problem-response';
import { logger } from '@/lib/logger';
import { requireApiPermission } from '@/lib/rbac';
import { readOnlyModeResponse } from '@/app/api/plans/_read-only-guard';
import { asMembersUserId, buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { countPendingChangeRequests, setMemberChangeApprovalEnabled } from '@/modules/members';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ERROR_ID = 'M114.admin.setting';

const bodySchema = z.object({ approvalEnabled: z.boolean() }).strict();

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!env.features.memberChangeApproval) {
    return problemResponse(404, 'not_found', 'Not found');
  }

  const ctx = await requireApiPermission(request, 'members.write');
  if ('response' in ctx) return ctx.response;
  const extras = { requestId: ctx.requestId };

  const deps = buildChangeRequestDeps(resolveTenantFromRequest(request));

  const row = await deps.tenantMemberChangeSettings.readInTenant(deps.tenant);
  if (!row.ok) {
    logger.error(
      { errorId: `${ERROR_ID}.settings_read_failed`, requestId: ctx.requestId, tenantId: deps.tenant.slug, err: row.error.code },
      'member-changes.setting: settings read failed',
    );
    return problemResponse(500, 'server_error', 'Could not load the setting', undefined, { extras });
  }

  const pendingCount = await countPendingChangeRequests(deps);
  if (!pendingCount.ok) {
    logger.error(
      { errorId: `${ERROR_ID}.pending_count_failed`, requestId: ctx.requestId, tenantId: deps.tenant.slug, err: pendingCount.error.message },
      'member-changes.setting: pending count failed',
    );
    return problemResponse(500, 'server_error', 'Could not load the setting', undefined, { extras });
  }

  return NextResponse.json({
    // no row yet = the new-tenant default (off, FR-031)
    approvalEnabled: row.value?.memberChangeApprovalEnabled === true,
    pendingCount: pendingCount.value.count,
  });
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  if (!env.features.memberChangeApproval) {
    return problemResponse(404, 'not_found', 'Not found');
  }

  const ctx = await requireApiPermission(request, 'members.write');
  if ('response' in ctx) return ctx.response;
  const extras = { requestId: ctx.requestId };

  // FR-036 — READ_ONLY_MODE (T116): 503 after the gate, before any write.
  const roResp = readOnlyModeResponse();
  if (roResp) return roResp;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return problemResponse(400, 'invalid_body', 'Body must be valid JSON', undefined, { extras });
  }
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return problemResponse(400, 'invalid_body', 'Invalid body', undefined, {
      extras: { ...extras, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    });
  }

  const deps = buildChangeRequestDeps(resolveTenantFromRequest(request));
  const result = await setMemberChangeApprovalEnabled(deps, {
    enabled: parsed.data.approvalEnabled,
    actorUserId: asMembersUserId(ctx.current.user.id),
    // the SESSION role, recorded as-is (audit-truth invariant)
    actorRole: ctx.current.user.role ?? null,
    requestId: ctx.requestId,
  });

  if (!result.ok) {
    logger.error(
      { errorId: `${ERROR_ID}.use_case_failed`, requestId: ctx.requestId, tenantId: deps.tenant.slug, err: result.error.message },
      'member-changes.setting: use case failed',
    );
    return problemResponse(500, 'server_error', 'Could not change the setting', undefined, { extras });
  }

  // The WIRE shape keeps `changedAt: null` for the no-op (the card branches on
  // it to decide whether to toast, R-L5); the Application outcome is a union
  // discriminated on `changed` (B3), so the null is minted HERE rather than
  // carried through the use case as a second field that could disagree.
  return NextResponse.json({
    approvalEnabled: result.value.approvalEnabled,
    changedAt: result.value.changed ? result.value.changedAt.toISOString() : null,
  });
}
