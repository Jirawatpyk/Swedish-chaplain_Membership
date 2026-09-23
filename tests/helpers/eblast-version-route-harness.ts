/**
 * F119 PR-2 — shared harness for the approval-round route contract tests:
 * `…/[id]/version` (T039 / T041 / T045 / T046 / T057 / T058 / T061 / T062a /
 * T149 / T150), `…/[id]/version/send` (T040 / T043 / T044) and
 * `…/[id]/schedule` (T042 / T044).
 *
 * The routes run against the REAL use cases (`startFormattedVersion`,
 * `saveFormattedVersion`, `listBroadcastVersions`, `sendVersionToMember`,
 * `confirmSchedule`) over the in-memory approval store from
 * `eblast-approval-fakes.ts` (whose outbox rows roll back with the store),
 * the REAL shared sanitiser (DOMPurify, the one content policy), a fake image
 * allow-list and a fake portal-contact directory. Only the
 * edges a unit cannot own are stubbed: the session gate, the tenant
 * resolver, the rate limiter, and the composition root (which is where the
 * feature flag is read — `harness.flagOn` stands in for it).
 *
 * Wiring, in each test file (vi.mock is hoisted, so every factory reaches the
 * harness lazily through a dynamic import):
 *
 *   vi.mock('@/lib/rbac', async () => (await import('../../helpers/eblast-version-route-harness')).rbacMock());
 *   vi.mock('@/lib/tenant-context', …tenantContextMock());
 *   vi.mock('@/lib/logger', …loggerMock());
 *   vi.mock('@/lib/broadcast-approval-deps', …approvalDepsMock());
 *   vi.mock('@/modules/broadcasts', …broadcastsBarrelMock());
 */
import { vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import { dompurifySanitizer } from '@/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer';
import type { BroadcastVersion } from '@/modules/broadcasts/domain/approval/broadcast-version';
import type { MemberDecision } from '@/modules/broadcasts/domain/approval/member-decision';
import type { PortalContact } from '@/modules/broadcasts/application/ports/member-portal-recipient-port';
import {
  makeFakeActorNameDirectory,
  makeFakeApprovalStore,
  makeFakeImageAllowlist,
  makeFakePortalRecipients,
  makePortalContact,
  makeRecordingF7Audit,
  type FakeApprovalStore,
  type RecordingF7Audit,
} from './eblast-approval-fakes';

export const HARNESS_TENANT = 'test-tenant';
export const MARKETING_USER_ID = '44444444-4444-4444-8444-444444444444';
export const ADMIN_USER_ID = '55555555-5555-4555-8555-555555555555';

export type HarnessRole = 'marketing' | 'admin' | 'super_admin' | 'manager';

/** The member the default `makeApprovalBroadcast()` row belongs to. */
export const HARNESS_MEMBER_ID = '22222222-2222-4222-8222-222222222222';

interface Harness {
  store: FakeApprovalStore;
  audit: RecordingF7Audit;
  names: Record<string, string | null>;
  allowlistHosts: string[];
  /** Active portal contacts per member id (T059's `no_portal_user` precondition). */
  portalContacts: Record<string, PortalContact[]>;
  flagOn: boolean;
  readonly requireApiPermission: ReturnType<typeof vi.fn>;
  readonly checkLimit: ReturnType<typeof vi.fn>;
}

export const harness: Harness = {
  store: makeFakeApprovalStore(),
  audit: makeRecordingF7Audit(),
  names: {},
  allowlistHosts: ['assets.swecham.zyncdata.app'],
  portalContacts: { [HARNESS_MEMBER_ID]: [makePortalContact()] },
  flagOn: true,
  requireApiPermission: vi.fn(),
  checkLimit: vi.fn(),
};

export function staffCtx(role: HarnessRole = 'marketing', userId = MARKETING_USER_ID) {
  return {
    current: {
      user: { id: userId, email: `${role}@swecham.test`, role, status: 'active' as const, displayName: role },
      session: { id: 'sess-1' },
    },
    sourceIp: '203.0.113.10',
    requestId: 'req-version-1',
  };
}

/** The gate's refusal for a role that lacks the key (or a member session). */
export const deniedResponse = () => ({
  response: NextResponse.json({ error: 'permission_denied' }, { status: 403 }),
});

/** Reset every piece of state; seed the store. Call in `beforeEach`. */
export function resetVersionHarness(
  seed: {
    readonly broadcasts?: readonly Broadcast[];
    readonly versions?: readonly BroadcastVersion[];
    readonly decisions?: readonly MemberDecision[];
  } = {},
): FakeApprovalStore {
  harness.store = makeFakeApprovalStore(seed);
  harness.audit = makeRecordingF7Audit();
  harness.names = {};
  harness.allowlistHosts = ['assets.swecham.zyncdata.app'];
  harness.portalContacts = { [HARNESS_MEMBER_ID]: [makePortalContact()] };
  harness.flagOn = true;
  harness.requireApiPermission.mockReset();
  harness.requireApiPermission.mockResolvedValue(staffCtx());
  harness.checkLimit.mockReset();
  harness.checkLimit.mockResolvedValue(ok(true));
  return harness.store;
}

// --- vi.mock factories -------------------------------------------------------

export function rbacMock() {
  return { requireApiPermission: (...args: unknown[]) => harness.requireApiPermission(...args) };
}

export function tenantContextMock() {
  return { resolveTenantFromRequest: () => asTenantContext(HARNESS_TENANT) };
}

export function loggerMock() {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
}

export function approvalDepsMock() {
  const tenant = asTenantContext(HARNESS_TENANT);
  const clock = { now: () => harness.store.now };
  return {
    makeStartFormattedVersionDeps: () => ({
      tenant,
      broadcastsRepo: harness.store.broadcastsRepo,
      versionsRepo: harness.store.versionsRepo,
      audit: harness.audit,
      clock,
      memberApprovalEnabled: harness.flagOn,
    }),
    makeSaveFormattedVersionDeps: () => ({
      tenant,
      broadcastsRepo: harness.store.broadcastsRepo,
      versionsRepo: harness.store.versionsRepo,
      sanitizer: dompurifySanitizer,
      imageAllowlist: makeFakeImageAllowlist(harness.allowlistHosts),
      audit: harness.audit,
      clock,
    }),
    makeListBroadcastVersionsDeps: () => ({
      tenant,
      broadcastsRepo: harness.store.broadcastsRepo,
      versionsRepo: harness.store.versionsRepo,
      decisionsRepo: harness.store.decisionsRepo,
      names: makeFakeActorNameDirectory(harness.names),
      audit: harness.audit,
    }),
    makeSendVersionToMemberDeps: () => ({
      tenant,
      broadcastsRepo: harness.store.broadcastsRepo,
      versionsRepo: harness.store.versionsRepo,
      sanitizer: dompurifySanitizer,
      imageAllowlist: makeFakeImageAllowlist(harness.allowlistHosts),
      portalRecipients: makeFakePortalRecipients(harness.portalContacts),
      outbox: harness.store.outbox,
      audit: harness.audit,
      clock,
    }),
    makeConfirmScheduleDeps: () => ({
      tenant,
      broadcastsRepo: harness.store.broadcastsRepo,
      versionsRepo: harness.store.versionsRepo,
      imageAllowlist: makeFakeImageAllowlist(harness.allowlistHosts),
      portalRecipients: makeFakePortalRecipients(harness.portalContacts),
      outbox: harness.store.outbox,
      audit: harness.audit,
      clock,
    }),
  };
}

/**
 * The barrel the version route imports, with the REAL use cases (imported by
 * path — the whole barrel would pull every Drizzle adapter) and the limiter
 * routed to `harness.checkLimit`.
 */
export async function broadcastsBarrelMock() {
  const start = await import('@/modules/broadcasts/application/use-cases/approval/start-formatted-version');
  const save = await import('@/modules/broadcasts/application/use-cases/approval/save-formatted-version');
  const list = await import('@/modules/broadcasts/application/use-cases/approval/list-broadcast-versions');
  const send = await import('@/modules/broadcasts/application/use-cases/approval/send-version-to-member');
  const schedule = await import('@/modules/broadcasts/application/use-cases/approval/confirm-schedule');
  const broadcast = await import('@/modules/broadcasts/domain/broadcast');
  const stage = await import('@/modules/broadcasts/domain/stage/broadcast-stage');
  return {
    startFormattedVersion: start.startFormattedVersion,
    saveFormattedVersion: save.saveFormattedVersion,
    listBroadcastVersions: list.listBroadcastVersions,
    sendVersionToMember: send.sendVersionToMember,
    confirmSchedule: schedule.confirmSchedule,
    parseBroadcastId: broadcast.parseBroadcastId,
    stageOf: stage.stageOf,
    broadcastsRateLimiter: { checkLimit: (...args: unknown[]) => harness.checkLimit(...args) },
  };
}

// --- requests ------------------------------------------------------------------

const url = (id: string) => `http://localhost/api/admin/broadcasts/${id}/version`;
export const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

export function postVersionRequest(id: string): NextRequest {
  return new NextRequest(url(id), { method: 'POST' });
}

export function patchVersionRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(url(id), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function getVersionRequest(id: string): NextRequest {
  return new NextRequest(url(id), { method: 'GET' });
}

export const importVersionRoute = () => import('@/app/api/admin/broadcasts/[id]/version/route');

/** `POST …/version/send` — the route reads no body; `body` is there to prove it ignores one (FR-005). */
export function postSendRequest(id: string, body?: unknown): NextRequest {
  return new NextRequest(`${url(id)}/send`, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

export function postScheduleRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/admin/broadcasts/${id}/schedule`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export const importSendRoute = () => import('@/app/api/admin/broadcasts/[id]/version/send/route');
export const importScheduleRoute = () => import('@/app/api/admin/broadcasts/[id]/schedule/route');
