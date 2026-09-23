/**
 * F119 PR-2 — composition root for the staff approval-round use cases
 * (`POST | PATCH | GET /api/admin/broadcasts/[id]/version`).
 *
 * Lives in `src/lib` for the reason `broadcast-brand-deps.ts` does: it
 * crosses a module boundary. Staff display names for the version thread come
 * from the auth module's barrel (`resolveActorIdentities` — display name
 * only, never an email), adapted to the broadcasts `ActorNameDirectoryPort`.
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
import { resolveActorIdentities } from '@/modules/auth';
import {
  dompurifySanitizer,
  drizzleBroadcastDecisionsRepo,
  drizzleBroadcastVersionsRepo,
  f7AuditAdapter,
  isEblastMemberApprovalEnabled,
  makeDrizzleBroadcastsRepo,
  makeValidateImageSourceAllowlistDeps,
  systemClock,
  type ActorNameDirectoryPort,
  type ListBroadcastVersionsDeps,
  type SaveFormattedVersionDeps,
  type StartFormattedVersionDeps,
} from '@/modules/broadcasts';
import { asTenantContext } from '@/modules/tenants';

export const actorNameDirectory: ActorNameDirectoryPort = {
  async resolveNames(ids) {
    const identities = await resolveActorIdentities(ids);
    const out = new Map<string, string | null>();
    for (const [id, identity] of identities) out.set(id, identity.displayName);
    return out;
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
