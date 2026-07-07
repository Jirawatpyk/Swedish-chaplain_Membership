/**
 * POST `/api/admin/events/erasure`
 *
 * F6 remediation PR 2.2 / P4 — by-email cross-event attendee PII erasure
 * (FR-032a / GDPR Article 17 / PDPA Section 30). Fans a data-subject-request
 * out across EVERY event registration sharing the subject's attendee email in
 * the caller's tenant. Best-effort bulk erasure: each registration is erased in
 * its OWN transaction (own-tx-per-row) so one poisoned row never rolls back the
 * siblings. Delegates entirely to `runEraseAttendeesByEmail` (PR 2.1 backend).
 *
 * Static segment `erasure` — Next.js resolves it in preference to the sibling
 * `[eventId]` dynamic segment, so this route never collides with the per-event
 * routes.
 *
 * Authz: **admin only** (FR-035 — manager 403 + `role_violation_blocked` audit,
 * member 404 via `adminOnlyWriterGuard`). Carry-forward #1: this destructive PII
 * surface is admin-gated at the route layer.
 *
 * Body: `{ email: string; reasonText: string }`
 *   - `email`      — the data subject's email. Normalised `.trim().toLowerCase()`
 *                    (carry-forward #4, consistent with ingest) then RFC-validated
 *                    (≤254 chars). NEVER logged / echoed in the audit summary.
 *   - `reasonText` — admin-supplied erasure justification (1-500 chars), threaded
 *                    to each per-registration erasure for DPO traceability.
 *
 * Responses:
 *   200 OK    { erasedCount, alreadyErasedCount, failedCount, truncated }
 *             — `truncated`/`failedCount>0` signal an INCOMPLETE pass; the caller
 *               (client panel) prompts the admin to re-run (carry-forward #3).
 *   400 BAD   malformed body / email not RFC / reasonText missing or >500
 *   403 FORB  manager (role_violation_blocked audit emitted)
 *   404 NOT   F6 flag off / member role / caller not staff
 *   500 ISE   backend enumerate-throw (carry-forward #2 — the `list` step fails
 *             loud; caught here + mapped to a clean 500, never an unhandled
 *             rejection).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { redactStack } from '@/lib/redact-stack';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { runEraseAttendeesByEmail } from '@/lib/events-admin-deps';
import { adminOnlyWriterGuard } from '../_lib/role-violation-audit';

export const runtime = 'nodejs';
/**
 * PR 4.1 follow-up #2 — raised 30 → 120s for headroom. The backend now
 * AUTO-LOOPS the fan-out (up to `MAX_SWEEP_ITERATIONS` batches of sequential
 * own-txs, each taking a per-registration advisory lock), which for a large-N
 * data subject can exceed 30s. 120s is a safe headroom well under Vercel's
 * 300s ceiling given the realistic N is tiny (dormant at SweCham scale).
 *
 * The fan-out's `MAX_SWEEP_ITERATIONS` guard — NOT this timeout — is the
 * PRIMARY bound on the loop: the guard makes an infinite loop impossible. This
 * timeout is only a wall-clock backstop; if it ever trips, every per-row
 * erasure that already committed stays committed (own-tx-per-row) and the
 * sweep is idempotently re-drivable (erased rows drop out on re-enumeration),
 * so a timeout never corrupts state or double-erases.
 */
export const maxDuration = 120;

const ATTEMPTED_ROUTE = '/api/admin/events/erasure';

// Raw body bound: reasonText 1-500 (matches the per-reg erase route); email a
// non-empty string with a generous DoS ceiling — the strict RFC + ≤254 check
// runs on the NORMALISED value below so a caller who pastes surrounding
// whitespace isn't rejected on a raw-length technicality.
const BodySchema = z.object({
  email: z
    .string()
    .min(1, 'email is required')
    .max(1000, 'email is too long'),
  reasonText: z
    .string()
    .min(1, 'reasonText is required')
    .max(500, 'reasonText must be 500 characters or fewer'),
});

// RFC email + ≤254 applied to the trimmed+lowered value (carry-forward #4).
const NormalisedEmailSchema = z
  .string()
  .min(1)
  .max(254, 'email must be 254 characters or fewer')
  .email('email must be a valid address');

export async function POST(request: NextRequest) {
  if (!env.features.f6EventCreate) {
    return new NextResponse(null, { status: 404 });
  }

  // FR-035 admin-only writer guard runs BEFORE the body parse so a
  // manager/member/unauthenticated probe never reaches validation (no
  // information-disclosure asymmetry) and the role_violation_blocked audit
  // fires for the full request. Manager → 403 + audit, member → 404 + audit,
  // no-session/unknown → 404.
  const guard = await adminOnlyWriterGuard(request, {
    attemptedRoute: ATTEMPTED_ROUTE,
    attemptedAction: 'erase_attendees_by_email',
    eventId: null,
  });
  if (guard.kind === 'deny') return guard.response;
  const actorUserId = guard.actorUserId;

  // Parse + validate body.
  let parsed: z.infer<typeof BodySchema>;
  try {
    const raw = await request.json();
    const parseResult = BodySchema.safeParse(raw);
    if (!parseResult.success) {
      return NextResponse.json(
        {
          title: 'Bad Request',
          detail: parseResult.error.issues[0]?.message ?? 'invalid body',
        },
        { status: 400 },
      );
    }
    parsed = parseResult.data;
  } catch {
    return NextResponse.json(
      { title: 'Bad Request', detail: 'malformed JSON body' },
      { status: 400 },
    );
  }

  // Carry-forward #4 — normalise the email consistent with ingest, THEN
  // RFC-validate the normalised value. A non-RFC / oversized address is a 400.
  const emailLower = parsed.email.trim().toLowerCase();
  const emailCheck = NormalisedEmailSchema.safeParse(emailLower);
  if (!emailCheck.success) {
    return NextResponse.json(
      {
        title: 'Bad Request',
        detail: emailCheck.error.issues[0]?.message ?? 'invalid email',
      },
      { status: 400 },
    );
  }

  let tenantCtx: ReturnType<typeof resolveTenantFromRequest>;
  try {
    tenantCtx = resolveTenantFromRequest(request);
  } catch (e) {
    logger.error(
      {
        event: 'admin_erase_by_email_tenant_resolve_failed',
        err: e instanceof Error ? e.message : String(e),
        // No email in the log line — it is the PII we are erasing.
      },
      '[F6] resolveTenantFromRequest threw on by-email erasure',
    );
    return NextResponse.json({ title: 'Internal Server Error' }, { status: 500 });
  }

  // Carry-forward #2 — the fan-out's `list` step fails LOUD (throws) on a repo
  // error so a silent empty enumeration can never mark a DSR complete while PII
  // survives. Catch the rejection here and map to a clean 500; never let it
  // escape as an unhandled rejection.
  let result: Awaited<ReturnType<typeof runEraseAttendeesByEmail>>;
  try {
    result = await runEraseAttendeesByEmail(tenantCtx.slug, {
      emailLower,
      actorUserId,
      reasonText: parsed.reasonText,
      occurredAt: new Date(),
    });
  } catch (e) {
    logger.error(
      {
        event: 'admin_erase_by_email_throw',
        err:
          e instanceof Error
            ? {
                name: e.name,
                message: e.message,
                stack:
                  typeof e.stack === 'string'
                    ? (redactStack(e.stack) ?? null)
                    : null,
              }
            : String(e),
        // Deliberately no email / attendee PII in the log line.
      },
      '[F6] /api/admin/events/erasure — runEraseAttendeesByEmail threw',
    );
    return NextResponse.json({ title: 'Internal Server Error' }, { status: 500 });
  }

  // The fan-out's error channel is `never` (best-effort; failures are tallied,
  // not surfaced as err). This guard is defensive belt-and-suspenders.
  if (!result.ok) {
    logger.error(
      { event: 'admin_erase_by_email_unexpected_err' },
      '[F6] by-email erasure returned an unexpected Result.err',
    );
    return NextResponse.json({ title: 'Internal Server Error' }, { status: 500 });
  }

  const { erasedCount, alreadyErasedCount, failedCount, truncated } =
    result.value;
  return NextResponse.json(
    { erasedCount, alreadyErasedCount, failedCount, truncated },
    { status: 200 },
  );
}
