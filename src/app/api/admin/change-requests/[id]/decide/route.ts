/**
 * F114 — `POST /api/admin/change-requests/[id]/decide` (US2; contracts/
 * admin-change-requests-api.md § decide; FR-013–FR-018, FR-020, FR-036,
 * FR-039).
 *
 * Platform flag OFF → 404 before any session work. Gate:
 * `requireApiPermission('members.write')` (denial → 403 + `permission_denied`
 * audit, the gate's own contract) → the in-route READ_ONLY_MODE 503 (T116 —
 * the proxy short-circuits too; this guard is the one every mutating route
 * carries). Body:
 * `{ decisions: [{ key, outcome }], reason?, note? }` (zod). Status mapping
 * from the use case: 200 (incl. `repeated: true` on an identical repeat);
 * 422 `decisions_incomplete` / `reason_required` / `reason_too_long` /
 * `contact_removed` / `validation_error`; 409 `already_decided` (with who
 * decided and how — FR-018) / `not_pending` / `member_archived` /
 * `member_erasing`; 404; 500 with `M114.admin.decide.<arm>`.
 *
 * The response view carries the submitter's and the reviewer's display names,
 * which the use case does not know (auth `users` lives outside the module),
 * so the route re-reads the joined row AFTER the commit.
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
import { serialiseChangeRequestForStaff, type StaffChangeRequestView } from '@/lib/change-request-staff-view';
import {
  DECISION_NOTE_MAX_LENGTH,
  DECISION_REASON_MAX_LENGTH,
  decideChangeRequest,
  type ChangeRequest,
  type ChangeRequestId,
  type ChangeRequestListRow,
} from '@/modules/members';
import type { ChangeRequestDeps } from '@/lib/members-change-request-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ERROR_ID = 'M114.admin.decide';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Length is enforced by the use case (`reason_too_long` names the field);
// the schema pins shape only, with a generous ceiling against abuse.
const bodySchema = z
  .object({
    decisions: z
      .array(
        z
          .object({
            key: z.string().min(1).max(40),
            outcome: z.enum(['approved', 'rejected']),
          })
          .strict(),
      )
      // a zero-field decision must never reach the use case (round 5, types F5)
      .min(1)
      .max(20),
    reason: z.string().max(DECISION_REASON_MAX_LENGTH * 4).nullable().optional(),
    note: z.string().max(DECISION_NOTE_MAX_LENGTH * 4).nullable().optional(),
  })
  .strict();

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!env.features.memberChangeApproval) {
    return problemResponse(404, 'not_found', 'Not found');
  }

  const ctx = await requireApiPermission(request, 'members.write');
  if ('response' in ctx) return ctx.response;
  const extras = { requestId: ctx.requestId };

  // FR-036 — READ_ONLY_MODE (T116): 503 after the gate, before any write.
  const roResp = readOnlyModeResponse();
  if (roResp) return roResp;

  const { id } = await context.params;
  if (!UUID_RE.test(id)) return problemResponse(404, 'not_found', 'Change request not found', undefined, { extras });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return problemResponse(400, 'invalid_body', 'Body must be valid JSON', undefined, { extras });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return problemResponse(422, 'validation_error', 'Invalid decision body', undefined, {
      extras: { ...extras, issues: parsed.error.issues },
    });
  }

  const deps = buildChangeRequestDeps(resolveTenantFromRequest(request));
  const changeRequestId = id as ChangeRequestId;
  const result = await decideChangeRequest(deps, {
    changeRequestId,
    decisions: parsed.data.decisions,
    reason: parsed.data.reason ?? null,
    note: parsed.data.note ?? null,
    actorUserId: asMembersUserId(ctx.current.user.id),
    actorRole: ctx.current.user.role,
    requestId: ctx.requestId,
  });

  if (result.ok) {
    const view = await staffView(deps, result.value.request, ctx.requestId);
    return NextResponse.json({
      request: view.request,
      applied: result.value.applied,
      rejected: result.value.rejected,
      repeated: result.value.repeated,
      // the decision is committed; only the joined display names could not
      // be re-read (round 5, silent-failure #8 — never a fabricated member)
      ...(view.viewUnavailable ? { viewUnavailable: true } : {}),
    });
  }

  const error = result.error;
  switch (error.type) {
    case 'decisions_incomplete':
      return problemResponse(422, 'decisions_incomplete', 'Every proposed field needs a decision', undefined, {
        extras: { ...extras, missing: error.missing, unknown: error.unknown, duplicates: error.duplicates },
      });
    case 'reason_required':
      return problemResponse(422, 'reason_required', 'A reason is required when a field is rejected', undefined, { extras });
    case 'reason_too_long':
      return problemResponse(422, 'reason_too_long', `The ${error.field} must be at most ${error.max} characters`, undefined, {
        extras: { ...extras, field: error.field, max: error.max },
      });
    case 'contact_removed':
      return problemResponse(422, 'contact_removed', 'The submitting contact was removed; these fields can only be rejected', undefined, {
        extras: { ...extras, keys: error.keys },
      });
    case 'validation_error':
      return problemResponse(422, 'validation_error', 'An approved value no longer passes validation; reject it instead', undefined, {
        extras: { ...extras, issues: error.issues },
      });
    case 'already_decided': {
      const recorded = await deps.changeRequestRepo.findListRowById(deps.tenant, changeRequestId);
      if (!recorded.ok) {
        logger.warn(
          { errorId: `${ERROR_ID}.already_decided_read_failed`, requestId: ctx.requestId, tenantId: deps.tenant.slug, changeRequestId, err: recorded.error.code },
          'change-requests.decide: already_decided but the recorded decision could not be read',
        );
      }
      const row: ChangeRequestListRow | null = recorded.ok ? recorded.value : null;
      return problemResponse(409, 'already_decided', 'This request was already decided', undefined, {
        extras: {
          ...extras,
          decidedBy: row?.decidedBy ?? null,
          decidedAt: (row?.request.decidedAt ?? error.decidedAt)?.toISOString() ?? null,
          outcome: row?.request.outcome ?? error.outcome,
        },
      });
    }
    case 'not_pending':
      return problemResponse(409, 'not_pending', 'This request is no longer pending', undefined, { extras });
    case 'member_archived':
      return problemResponse(409, 'member_archived', 'The member is archived; reject the request or unarchive the member first', undefined, { extras });
    case 'member_erasing':
      return problemResponse(409, 'member_erasing', 'The member is being erased; the request cannot be approved', undefined, { extras });
    case 'not_found':
      return problemResponse(404, 'not_found', 'Change request not found', undefined, { extras });
    case 'server_error':
    default:
      logger.error(
        { errorId: `${ERROR_ID}.use_case_failed`, requestId: ctx.requestId, tenantId: deps.tenant.slug, changeRequestId: id, err: error.type },
        'change-requests.decide: use case failed',
      );
      return problemResponse(500, 'server_error', 'The decision could not be recorded', undefined, { extras });
  }
}

/**
 * The joined row (display names) after the commit. On a read fault the
 * response carries the BARE request (id / state / outcome / timestamps — what
 * the client needs to toast and navigate) plus `viewUnavailable: true`; it
 * used to fabricate a member (`companyName: ''`, `memberNumber: 0`,
 * `archived: false`) and hand it back as fact (round 5, silent-failure #8).
 */
async function staffView(
  deps: ChangeRequestDeps,
  request: ChangeRequest,
  requestId: string,
): Promise<{ request: StaffChangeRequestView | BareDecidedRequest; viewUnavailable: boolean }> {
  const row = await deps.changeRequestRepo.findListRowById(deps.tenant, request.id);
  if (row.ok) return { request: serialiseChangeRequestForStaff(row.value), viewUnavailable: false };
  logger.error(
    { errorId: `${ERROR_ID}.view_read_failed`, requestId, tenantId: deps.tenant.slug, changeRequestId: request.id, err: row.error.code },
    'change-requests.decide: decision committed but the view re-read failed',
  );
  return {
    request: {
      id: request.id,
      memberId: request.memberId,
      scope: request.scope,
      state: request.state,
      outcome: request.outcome,
      submittedAt: request.submittedAt.toISOString(),
      decidedAt: request.decidedAt?.toISOString() ?? null,
    },
    viewUnavailable: true,
  };
}

type BareDecidedRequest = {
  readonly id: string;
  readonly memberId: string;
  readonly scope: ChangeRequest['scope'];
  readonly state: ChangeRequest['state'];
  readonly outcome: ChangeRequest['outcome'];
  readonly submittedAt: string;
  readonly decidedAt: string | null;
};
