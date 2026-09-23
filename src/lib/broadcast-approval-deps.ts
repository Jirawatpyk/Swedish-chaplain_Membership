/**
 * F119 PR-2 — composition root for the staff approval-round use cases
 * (`POST | PATCH | GET /api/admin/broadcasts/[id]/version`,
 * `POST …/[id]/version/send`, `POST …/[id]/schedule`).
 *
 * Lives in `src/lib` for the reason `broadcast-brand-deps.ts` does: it
 * crosses module boundaries, through barrels only:
 *   - staff display names for the version thread — the auth barrel's
 *     `resolveActorIdentities` (display name only, never an email), adapted
 *     to the broadcasts `ActorNameDirectoryPort`;
 *   - the member company's ACTIVE portal contacts for the send (T059) and the
 *     schedule confirmation (T060) — the members barrel's contact repo on the
 *     caller's tenant tx (contacts are RLS-scoped), then the auth barrel's
 *     `listActiveUserIdsWithRole` for the linked logins (`users` is
 *     cross-tenant, read on the plain client), adapted to
 *     `MemberPortalRecipientPort`.
 *
 * The feature flag is read HERE, per request, and handed to the use case as a
 * boolean (T152): Application never reads `env`. The use case — not the
 * route — decides what the flag means, on the status it re-reads under the
 * row lock (research R18: the flag gates the `submitted → in_design` edge,
 * not the route).
 *
 * Every repo here threads the use case's `runInTenant` tx; none reaches for
 * the pool-global `db`.
 */
import type { TenantTx } from '@/lib/db';
import { listActiveUserIdsWithRole, resolveActorIdentities } from '@/modules/auth';
import {
  dompurifySanitizer,
  drizzleBroadcastDecisionsRepo,
  drizzleBroadcastVersionsRepo,
  eblastNotificationOutbox,
  f7AuditAdapter,
  isEblastMemberApprovalEnabled,
  makeDrizzleBroadcastsRepo,
  makeValidateImageSourceAllowlistDeps,
  systemClock,
  type ActorNameDirectoryPort,
  type ConfirmScheduleDeps,
  type ListBroadcastVersionsDeps,
  type MemberPortalRecipientPort,
  type SaveFormattedVersionDeps,
  type SendVersionToMemberDeps,
  type StartFormattedVersionDeps,
} from '@/modules/broadcasts';
import { asMemberId, drizzleContactRepo } from '@/modules/members';
import { asTenantContext } from '@/modules/tenants';

export const actorNameDirectory: ActorNameDirectoryPort = {
  async resolveNames(ids) {
    const identities = await resolveActorIdentities(ids);
    const out = new Map<string, string | null>();
    for (const [id, identity] of identities) out.set(id, identity.displayName);
    return out;
  },
};

/**
 * Live contacts of the member linked to an ACTIVE `member`-role login. A
 * failed contact read THROWS so the caller's tx rolls back — an empty list
 * must mean "nobody can approve", never "the read failed".
 */
export const memberPortalRecipients: MemberPortalRecipientPort = {
  async listActivePortalContacts(_tenant, memberId, tx) {
    const listed = await drizzleContactRepo.listByMemberInTx(tx as TenantTx, asMemberId(memberId));
    if (!listed.ok) throw new Error(`portal contact read failed: ${listed.error.code}`);
    const linked = listed.value.flatMap((c) =>
      c.removedAt === null && c.linkedUserId !== null ? [{ contact: c, userId: c.linkedUserId as string }] : [],
    );
    const active = await listActiveUserIdsWithRole(
      linked.map((l) => l.userId),
      'member',
    );
    return linked
      .filter((l) => active.has(l.userId))
      .map(({ contact, userId }) => ({
        contactId: contact.contactId,
        email: contact.email,
        locale: contact.preferredLanguage,
        linkedUserId: userId,
        isPrimary: contact.isPrimary,
      }));
  },
};

export function makeStartFormattedVersionDeps(tenantId: string): StartFormattedVersionDeps {
  return {
    tenant: asTenantContext(tenantId),
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    versionsRepo: drizzleBroadcastVersionsRepo,
    audit: f7AuditAdapter,
    clock: systemClock,
    memberApprovalEnabled: isEblastMemberApprovalEnabled(),
  };
}

export function makeSaveFormattedVersionDeps(tenantId: string): SaveFormattedVersionDeps {
  return {
    tenant: asTenantContext(tenantId),
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    versionsRepo: drizzleBroadcastVersionsRepo,
    sanitizer: dompurifySanitizer,
    imageAllowlist: makeValidateImageSourceAllowlistDeps(tenantId).allowlistPort,
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

export function makeListBroadcastVersionsDeps(tenantId: string): ListBroadcastVersionsDeps {
  return {
    tenant: asTenantContext(tenantId),
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    versionsRepo: drizzleBroadcastVersionsRepo,
    decisionsRepo: drizzleBroadcastDecisionsRepo,
    names: actorNameDirectory,
    audit: f7AuditAdapter,
  };
}

export function makeSendVersionToMemberDeps(tenantId: string): SendVersionToMemberDeps {
  return {
    tenant: asTenantContext(tenantId),
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    versionsRepo: drizzleBroadcastVersionsRepo,
    sanitizer: dompurifySanitizer,
    imageAllowlist: makeValidateImageSourceAllowlistDeps(tenantId).allowlistPort,
    portalRecipients: memberPortalRecipients,
    outbox: eblastNotificationOutbox,
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

export function makeConfirmScheduleDeps(tenantId: string): ConfirmScheduleDeps {
  return {
    tenant: asTenantContext(tenantId),
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    versionsRepo: drizzleBroadcastVersionsRepo,
    imageAllowlist: makeValidateImageSourceAllowlistDeps(tenantId).allowlistPort,
    portalRecipients: memberPortalRecipients,
    outbox: eblastNotificationOutbox,
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}
