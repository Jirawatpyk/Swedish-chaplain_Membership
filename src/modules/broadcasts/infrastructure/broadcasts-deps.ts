/**
 * F7 broadcasts composition root.
 *
 * Mirrors F4 `invoicing-deps.ts` shape. Factories are per-call (per
 * tenant) for repos that need bound tenant context; stateless adapters
 * are module-level constants.
 */
import { asTenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';
import { makeDrizzleBroadcastsRepo } from './db/drizzle-broadcasts-repo';
import { makeDrizzleBroadcastSegmentDefinitionsRepo } from './db/drizzle-broadcast-segment-definitions-repo';
import { makeDrizzleMarketingUnsubscribesRepo } from './db/drizzle-marketing-unsubscribes-repo';
import { rfc5321EmailValidator } from './email-validator/rfc5321-email-validator';
import { membersBridge } from './members-bridge';
import { plansBridge } from './plans-bridge';
import { eventAttendeesStub } from './event-attendees-stub';
import { f7AuditAdapter } from './audit-adapter';
import { broadcastsRateLimiter } from './rate-limiter';
import { dompurifySanitizer } from './sanitizer/dompurify-sanitizer';
import { resendBroadcastsGateway } from './resend/resend-broadcasts-gateway';

import type { ClockPort } from '../application/ports/clock-port';
import type { SaveDraftDeps } from '../application/use-cases/save-draft';
import type { SubmitBroadcastDeps } from '../application/use-cases/submit-broadcast';
import type { ComputeQuotaDeps } from '../application/use-cases/compute-quota-counter';
import type { EnforceTenantContextDeps } from '../application/use-cases/enforce-tenant-context';
import type { ApproveBroadcastDeps } from '../application/use-cases/approve-broadcast';
import type { RejectBroadcastDeps } from '../application/use-cases/reject-broadcast';
import type { CancelBroadcastDeps } from '../application/use-cases/cancel-broadcast';
import type { ProxySubmitBroadcastDeps } from '../application/use-cases/proxy-submit-broadcast';
import type { ClearHaltDeps } from '../application/use-cases/clear-halt';
import type { DispatchScheduledBroadcastDeps } from '../application/use-cases/dispatch-scheduled-broadcast';
import type { AcknowledgeBroadcastsTermsDeps } from '../application/use-cases/acknowledge-broadcasts-terms';
import type { GetMemberBroadcastDeps } from '../application/use-cases/get-member-broadcast';
import type { ListMemberBroadcastsDeps } from '../application/use-cases/list-member-broadcasts';

export const systemClock: ClockPort = {
  now: () => new Date(),
};

export function makeSaveDraftDeps(tenantId: string): SaveDraftDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    sanitizer: dompurifySanitizer,
    membersBridge,
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

export function makeSubmitBroadcastDeps(
  tenantId: string,
): SubmitBroadcastDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    sanitizer: dompurifySanitizer,
    membersBridge,
    plansBridge,
    emailValidator: rfc5321EmailValidator,
    eventAttendees: eventAttendeesStub,
    marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenantId),
    rateLimiter: broadcastsRateLimiter,
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

export function makeComputeQuotaDeps(tenantId: string): ComputeQuotaDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    plansBridge,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    clock: systemClock,
  };
}

export function makeEnforceTenantContextDeps(
  tenantId: string,
): EnforceTenantContextDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    audit: f7AuditAdapter,
  };
}

/**
 * Lookup a single broadcast for a member detail page (used by
 * `GET /api/broadcasts/[id]`). Combines `findById` + tenant-context
 * enforcement.
 */
export function makeGetBroadcastDeps(tenantId: string): {
  readonly tenantId: string;
  readonly broadcastsRepo: ReturnType<typeof makeDrizzleBroadcastsRepo>;
  readonly enforceTenantContext: EnforceTenantContextDeps;
} {
  return {
    tenantId,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    enforceTenantContext: makeEnforceTenantContextDeps(tenantId),
  };
}

/** Segment definitions for the compose surface dropdown. */
export function makeListSegmentDefinitionsDeps(tenantId: string): {
  readonly segmentDefinitionsRepo: ReturnType<
    typeof makeDrizzleBroadcastSegmentDefinitionsRepo
  >;
  readonly tenantId: string;
} {
  return {
    tenantId,
    segmentDefinitionsRepo:
      makeDrizzleBroadcastSegmentDefinitionsRepo(tenantId),
  };
}

// =====================================================================
// Phase 4 US2 — admin review use-case factories
// =====================================================================

export function makeApproveBroadcastDeps(
  tenantId: string,
): ApproveBroadcastDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

export function makeRejectBroadcastDeps(
  tenantId: string,
): RejectBroadcastDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

export function makeCancelBroadcastDeps(
  tenantId: string,
): CancelBroadcastDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

export function makeProxySubmitBroadcastDeps(
  tenantId: string,
): ProxySubmitBroadcastDeps {
  // Same shape as submit-broadcast deps; use case delegates to
  // submitBroadcast under the hood.
  return makeSubmitBroadcastDeps(tenantId);
}

export function makeClearHaltDeps(tenantId: string): ClearHaltDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    membersBridge,
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

/**
 * Cron worker composition root. Wires the live Resend Broadcasts SDK
 * adapter.
 *
 * `fromEmail` is sourced from `env.broadcasts.fromEmail` (zod-validated
 * at boot — refuses IANA reserved TLDs per review C1 — 2026-04-30) so
 * this factory cannot accidentally dispatch from a placeholder address.
 */
export function makeDispatchScheduledBroadcastDeps(
  tenantId: string,
): DispatchScheduledBroadcastDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    broadcastsGateway: resendBroadcastsGateway,
    membersBridge,
    marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenantId),
    eventAttendees: eventAttendeesStub,
    audit: f7AuditAdapter,
    clock: systemClock,
    fromEmail: env.broadcasts.fromEmail,
  };
}

// =====================================================================
// Phase 5 US3 — member quota + history surface use-case factories
// =====================================================================

export function makeAcknowledgeBroadcastsTermsDeps(
  tenantId: string,
): AcknowledgeBroadcastsTermsDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    membersBridge,
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

export function makeGetMemberBroadcastDeps(
  tenantId: string,
): GetMemberBroadcastDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    audit: f7AuditAdapter,
  };
}

export function makeListMemberBroadcastsDeps(
  tenantId: string,
): ListMemberBroadcastsDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
  };
}
