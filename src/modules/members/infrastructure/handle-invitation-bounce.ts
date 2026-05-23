/**
 * Cross-cutting orchestrator for the F3 invitation-email bounce flow
 * (spec § Edge Cases). The Resend webhook (`/api/webhooks/resend`) is
 * tenant-agnostic — it receives a bounce for ANY `to` address and does not
 * know which tenant owns it. This module:
 *
 *   1. Resolves the bounced email to every (tenant, contact) that still has a
 *      LIVE pending invitation to it — cross-tenant, via the global Drizzle
 *      client (system role reads across tenants; mirrors
 *      `renewals/.../lookup-member-by-email.ts`).
 *   2. For each, runs the tenant-scoped `markInvitationBounced` use-case so the
 *      `invite_bounced_at` write + `invitation_bounced` audit happen inside the
 *      OWNER tenant's RLS scope (Constitution Principle I — the same bounced
 *      email may be a contact in multiple tenants; each is marked in its own
 *      tenant, never cross-tenant).
 *
 * Best-effort + fail-soft: a per-tenant failure is logged but never thrown, so
 * the webhook always returns 200 (a 5xx would trigger a Resend retry storm).
 */
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { asTenantContext } from '@/modules/tenants';
import { invitations } from '@/modules/auth/infrastructure/db/schema';
import { contacts } from './db/schema-contacts';
import { drizzleContactRepo } from './db/drizzle-contact-repo';
import { drizzleAuditAdapter } from './audit/audit-adapter';
import {
  markInvitationBounced,
  type MarkInvitationBouncedDeps,
} from '../application/use-cases/mark-invitation-bounced';
import type { ContactId } from '../domain/contact';
import type { MemberId } from '../domain/member';

interface BouncedInviteContact {
  readonly tenantId: string;
  readonly memberId: string;
  readonly contactId: string;
  readonly email: string;
}

/**
 * Cross-tenant lookup: every contact with a LIVE pending invitation whose
 * email matches `email` (case-insensitive) and which is not already marked
 * bounced. Returns [] when the email has no pending invite anywhere.
 */
export async function resolveBouncedInviteContacts(
  email: string,
): Promise<readonly BouncedInviteContact[]> {
  if (typeof email !== 'string' || email.length === 0) return [];
  const rows = await db
    .select({
      tenantId: contacts.tenantId,
      memberId: contacts.memberId,
      contactId: contacts.contactId,
      email: contacts.email,
    })
    .from(contacts)
    .innerJoin(invitations, eq(invitations.userId, contacts.linkedUserId))
    .where(
      and(
        sql`LOWER(${contacts.email}) = LOWER(${email})`,
        isNull(contacts.removedAt),
        isNull(contacts.inviteBouncedAt),
        isNull(invitations.consumedAt),
        gt(invitations.expiresAt, sql`NOW()`),
      ),
    )
    // Bound the cross-tenant scan: the orchestrator runs one synchronous
    // runInTenant round-trip PER result, on a webhook that must stay fast (a
    // slow webhook → Resend retry storm). A bounced address being a LIVE
    // pending-invite contact in >200 tenants is pathological; cap defensively.
    .limit(200);
  return rows;
}

/**
 * Handle a single Resend `email.bounced` event for an invitation email.
 * Resolves the owner tenant(s) + marks each. Never throws (webhook contract).
 * Returns the number of (tenant, contact) invitations marked.
 */
export async function handleInvitationBounce(
  toEmail: string,
  requestId: string,
  bouncedAt: Date = new Date(),
): Promise<{ marked: number }> {
  let targets: readonly BouncedInviteContact[];
  try {
    targets = await resolveBouncedInviteContacts(toEmail);
  } catch (e) {
    logger.error(
      { err: e instanceof Error ? e.message : String(e), requestId },
      'invitation_bounce.resolve_failed',
    );
    return { marked: 0 };
  }

  let marked = 0;
  let failed = 0;
  for (const t of targets) {
    // Per-tenant try/catch keeps the fail-soft contract: a malformed tenant
    // slug (asTenantContext throws synchronously) or any unexpected throw
    // marks ONLY that target as failed and continues with the rest — it must
    // never abort the batch or bubble a 5xx to the webhook.
    try {
      const deps: MarkInvitationBouncedDeps = {
        tenant: asTenantContext(t.tenantId),
        contactRepo: drizzleContactRepo,
        audit: drizzleAuditAdapter,
      };
      const result = await markInvitationBounced(deps, {
        contactId: t.contactId as ContactId,
        memberId: t.memberId as MemberId,
        toEmail: t.email,
        requestId,
        bouncedAt,
      });
      if (result.ok) {
        if (result.value.marked) marked += 1;
      } else {
        failed += 1;
        logger.error(
          { tenantId: t.tenantId, contactId: t.contactId, requestId, reason: result.error.message },
          'invitation_bounce.mark_failed',
        );
      }
    } catch (e) {
      failed += 1;
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          tenantId: t.tenantId,
          contactId: t.contactId,
          requestId,
        },
        'invitation_bounce.mark_threw',
      );
    }
  }
  // Silent-bounce-loss alarm: pending invites WERE found but EVERY one failed to
  // mark (e.g. the 0181 system actor isn't seeded in this env → audit FK
  // violation on every attempt). Distinct from the benign "no pending invites"
  // (failed===0) and idempotent re-delivery (marked:false, ok) paths — this is
  // the "silent bounce = data integrity bug" case the spec warns about.
  if (failed > 0 && marked === 0) {
    logger.error(
      { toEmail, requestId, targets: targets.length, failed },
      'invitation_bounce.all_targets_failed',
    );
  }
  return { marked };
}
