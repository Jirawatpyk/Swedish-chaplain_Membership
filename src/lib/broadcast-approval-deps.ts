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
 *     `listActiveUserIdsWithRole` for the linked logins on the SAME tx
 *     (`users` is cross-tenant with no RLS; the caller holds a row lock, so a
 *     second pool connection is not taken), adapted to
 *     `MemberPortalRecipientPort`;
 *   - the marketing hand-off roster for the member's decision (T078) and the
 *     day-23 / day-30 lifecycle notices (T130) —
 *     `src/lib/broadcast-marketing-deps.ts` (auth barrel, evaluator-derived).
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
import { makeMarketingDirectory } from '@/lib/broadcast-marketing-deps';
import { listActiveUserIdsWithRole, resolveActorIdentities } from '@/modules/auth';
import {
  ApprovalDependencyError,
  dompurifySanitizer,
  drizzleApprovalLifecycleScan,
  drizzleBroadcastDecisionsRepo,
  drizzleBroadcastVersionsRepo,
  eblastNotificationOutbox,
  f7AuditAdapter,
  isEblastMemberApprovalEnabled,
  makeDrizzleBroadcastsRepo,
  makeValidateImageSourceAllowlistDeps,
  membersBridge,
  membershipAccessBridge,
  systemClock,
  type ActorNameDirectoryPort,
  type ConfirmScheduleDeps,
  type ExpireStaleMemberApprovalsDeps,
  type GetMemberVersionThreadDeps,
  type ReadMemberEblastViewDeps,
  type ListBroadcastVersionsDeps,
  type ReadDispatchHoldDeps,
  type ReadFormattingWarningsDeps,
  type RecordMemberDecisionDeps,
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
    // Round-4 B3 — the read and its repo code travel as fields, so a caller's
    // log says which dependency failed rather than a bare `Error`.
    if (!listed.ok) throw new ApprovalDependencyError('portal_contacts', listed.error.code);
    const linked = listed.value.flatMap((c) =>
      c.removedAt === null && c.linkedUserId !== null ? [{ contact: c, userId: c.linkedUserId as string }] : [],
    );
    // T166 follow-up — on the SAME tx: the callers hold the broadcast row lock,
    // and a second pool connection per call starves the pool under load.
    const active = await listActiveUserIdsWithRole(
      linked.map((l) => l.userId),
      'member',
      tx as TenantTx,
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
    // T166 S-H1 — the send-time standing rules submit applies.
    sendStanding: { membersBridge, membershipAccess: membershipAccessBridge },
  };
}

/** T078 — the member's decision; the hand-off roster is the tenant's marketing users. */
export function makeRecordMemberDecisionDeps(tenantId: string): RecordMemberDecisionDeps {
  return {
    tenant: asTenantContext(tenantId),
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    versionsRepo: drizzleBroadcastVersionsRepo,
    decisionsRepo: drizzleBroadcastDecisionsRepo,
    marketingDirectory: makeMarketingDirectory(tenantId),
    outbox: eblastNotificationOutbox,
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

/** T087 — the member's version thread (read-only; the owning-member rule is the use case's). */
export function makeGetMemberVersionThreadDeps(tenantId: string): GetMemberVersionThreadDeps {
  return {
    tenant: asTenantContext(tenantId),
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    versionsRepo: drizzleBroadcastVersionsRepo,
    decisionsRepo: drizzleBroadcastDecisionsRepo,
    audit: f7AuditAdapter,
  };
}

/** T141a — the workflow half of the member detail (read-only; the caller owner-checks first). */
export function makeReadMemberEblastViewDeps(tenantId: string): ReadMemberEblastViewDeps {
  return {
    tenant: asTenantContext(tenantId),
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    versionsRepo: drizzleBroadcastVersionsRepo,
  };
}

/** T063 — the staff detail page's two standing warnings (read-only). */
export function makeReadFormattingWarningsDeps(tenantId: string): ReadFormattingWarningsDeps {
  return {
    tenant: asTenantContext(tenantId),
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    portalRecipients: memberPortalRecipients,
    imageAllowlist: makeValidateImageSourceAllowlistDeps(tenantId).allowlistPort,
  };
}

/**
 * F119 PR-A R1 — the detail page's "held" note (read-only). The same two
 * standing reads the dispatch cron makes, unmemoised (a page renders one row).
 */
export function makeReadDispatchHoldDeps(tenantId: string): ReadDispatchHoldDeps {
  return {
    tenant: asTenantContext(tenantId),
    sendStanding: { membersBridge, membershipAccess: membershipAccessBridge },
    clock: systemClock,
  };
}

/**
 * T130 — the daily approval-lifecycle tick (the `prune-expired-drafts` cron's
 * third block): the member's portal contacts for the reminders, the marketing
 * roster for the warning and the closure, the ids-only outbox on each row's tx.
 */
export function makeExpireStaleMemberApprovalsDeps(tenantId: string): ExpireStaleMemberApprovalsDeps {
  return {
    tenant: asTenantContext(tenantId),
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    versionsRepo: drizzleBroadcastVersionsRepo,
    lifecycleScan: drizzleApprovalLifecycleScan,
    portalRecipients: memberPortalRecipients,
    marketingDirectory: makeMarketingDirectory(tenantId),
    outbox: eblastNotificationOutbox,
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}
