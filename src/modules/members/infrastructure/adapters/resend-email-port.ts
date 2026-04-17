/**
 * EmailPort adapter — outbox-backed enqueue (US3.b.1 / T049).
 *
 * Implements `EmailPort.enqueue` by inserting a row into
 * `notifications_outbox`. The row is drained by the Vercel Cron
 * dispatcher (src/app/api/cron/outbox-dispatch/route.ts) which
 * actually calls Resend. This decouples DB transaction durability
 * from Resend availability — a Resend outage never rolls back the
 * domain transaction that enqueued the email.
 *
 * Two entry points:
 *   - `enqueue(ctx, req)`            — starts its own runInTenant tx.
 *                                       Suitable for simple one-shot
 *                                       enqueues (e.g. member invitation).
 *   - `enqueueInTx(tx, ctx, req)`    — uses a caller-provided transaction.
 *                                       Required for FR-012a's 6-step
 *                                       atomic transaction (T080, US3.b.2)
 *                                       where the outbox insert MUST
 *                                       commit atomically with the
 *                                       contact + user-email update + the
 *                                       session revocation.
 *
 * The port interface (`EmailPort`) only exposes `enqueue`; callers that
 * need the in-tx variant import the adapter module directly. Crossing
 * the Application→Infrastructure boundary here is a documented exception
 * — the same escape hatch F1 uses for the webhook receiver.
 */

import type { TenantTx } from '@/lib/db';
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
// The outbox table lives in the auth-shared schema (see research.md § 4 /
// migration 0011 header). This adapter imports the Drizzle table binding
// directly rather than a public barrel — no Application use case wraps
// the outbox INSERT; it is pure infrastructure plumbing.
import {
  notificationsOutbox,
  type NotificationsOutboxInsert,
} from '@/modules/auth/infrastructure/db/schema';
import type {
  EmailEnqueue,
  EmailPort,
} from '../../application/ports/email-port';
import type { RepoError } from '../../application/ports/member-repo';

/**
 * Insert one outbox row inside the caller's transaction. The row is
 * created in `pending` state with `attempts = 0` and `next_retry_at =
 * now()` so the very next dispatcher tick picks it up.
 */
export async function enqueueInTx(
  tx: TenantTx,
  ctx: TenantContext,
  request: EmailEnqueue,
): Promise<Result<{ outboxRowId: string }, RepoError>> {
  try {
    const insert: NotificationsOutboxInsert = {
      tenantId: ctx.slug,
      notificationType: request.type,
      toEmail: request.toEmail.toLowerCase(),
      locale: request.locale,
      contextData: request.contextData,
    };
    const [row] = await tx
      .insert(notificationsOutbox)
      .values(insert)
      .returning({ id: notificationsOutbox.id });
    if (!row) {
      return err({
        code: 'repo.unexpected',
        cause: 'outbox insert returned no row',
      });
    }
    return ok({ outboxRowId: row.id });
  } catch (e) {
    return err({ code: 'repo.unexpected', cause: e });
  }
}

/**
 * Public port implementation — standalone enqueue that opens its own
 * tenant-scoped transaction. Use this when the caller has no
 * pre-existing tx (e.g. re-send verification, stand-alone invitation).
 */
export const resendEmailPort: EmailPort = {
  async enqueue(ctx, request) {
    try {
      return await runInTenant(ctx, (tx) => enqueueInTx(tx, ctx, request));
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },

  enqueueInTx,
};
