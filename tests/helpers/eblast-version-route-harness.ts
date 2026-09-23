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
import type { MarketingDirectoryPort, MarketingRecipient } from '@/modules/broadcasts/application/ports/marketing-directory-port';
import {
  makeFakeActorNameDirectory,
  makeFakeApprovalStore,
  makeFakeBroadcastImagesRepo,
  makeFakeImageAllowlist,
  makeFakeMarketingDirectory,
  makeFakePortalRecipients,
  makeMarketingRecipient,
  makePortalContact,
  makeRecordingF7Audit,
  type FakeApprovalStore,
  type FakeBroadcastImagesRepo,
  type RecordingF7Audit,
} from './eblast-approval-fakes';

export const HARNESS_TENANT = 'test-tenant';
export const MARKETING_USER_ID = '44444444-4444-4444-8444-444444444444';
export const ADMIN_USER_ID = '55555555-5555-4555-8555-555555555555';

export type HarnessRole = 'marketing' | 'admin' | 'super_admin' | 'manager';

/** The member the default `makeApprovalBroadcast()` row belongs to. */
export const HARNESS_MEMBER_ID = '22222222-2222-4222-8222-222222222222';
/** Another member of the SAME tenant — the cross-member probe (T073). */
export const OTHER_MEMBER_ID = '77777777-7777-4777-8777-777777777777';
/** The owning member's portal login (= the default broadcast's submitter) and its contact. */
export const PORTAL_USER_ID = '33333333-3333-4333-8333-333333333333';
export const PORTAL_CONTACT_ID = 'dddddddd-0000-4000-8000-000000000001';
/** A second marketing recipient, so "one row PER recipient" is observable (T078). */
export const SECOND_MARKETER = makeMarketingRecipient({ userId: '88888888-8888-4888-8888-888888888888', email: 'marketing-2@swecham.test' });

/**
 * The portal session behind `requireMemberContext` (T067–T081a). `role` is
 * the session's role: a staff role makes the REAL `requireMemberContext`
 * refuse it (`memberContextMock`), which is how FR-013 is asserted directly.
 */
export interface HarnessMemberSession {
  role: 'member' | HarnessRole;
  userId: string;
  memberId: string;
  contactId: string;
  /**
   * T074 — hand a MEMBER session to the REAL `requireMemberContext` too, so
   * its `checkPortalAccess` gate runs. The suite that sets it must `vi.mock`
   * the two reads that gate makes (`@/modules/members/members-deps`,
   * `@/lib/portal-access-deps`); unset, a member resolves to `memberCtx()`.
   */
  realGate?: boolean;
}

interface Harness {
  store: FakeApprovalStore;
  audit: RecordingF7Audit;
  names: Record<string, string | null>;
  allowlistHosts: string[];
  /** Active portal contacts per member id (T059's `no_portal_user` precondition). */
  portalContacts: Record<string, PortalContact[]>;
  flagOn: boolean;
  member: HarnessMemberSession;
  /** The hand-off roster `MarketingDirectoryPort.listRecipients` returns (T078). */
  marketingRoster: MarketingRecipient[];
  /** The `broadcast_images` rows the widened cancel / reject stamp (T081). */
  images: FakeBroadcastImagesRepo;
  readonly requireApiPermission: ReturnType<typeof vi.fn>;
  readonly checkLimit: ReturnType<typeof vi.fn>;
}

const defaultMemberSession = (): HarnessMemberSession => ({
  role: 'member',
  userId: PORTAL_USER_ID,
  memberId: HARNESS_MEMBER_ID,
  contactId: PORTAL_CONTACT_ID,
});

export const harness: Harness = {
  store: makeFakeApprovalStore(),
  audit: makeRecordingF7Audit(),
  names: {},
  allowlistHosts: ['assets.swecham.zyncdata.app'],
  portalContacts: { [HARNESS_MEMBER_ID]: [makePortalContact()] },
  flagOn: true,
  member: defaultMemberSession(),
  marketingRoster: [makeMarketingRecipient(), SECOND_MARKETER],
  images: makeFakeBroadcastImagesRepo(),
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
  harness.member = defaultMemberSession();
  harness.marketingRoster = [makeMarketingRecipient(), SECOND_MARKETER];
  harness.images = makeFakeBroadcastImagesRepo();
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

/** The resolved portal context for `harness.member` (a `member` session). */
export function memberCtx() {
  const m = harness.member;
  return {
    current: {
      user: { id: m.userId, email: 'owner@acme.test', role: 'member' as const, status: 'active' as const, displayName: 'Owner' },
      session: { id: 'sess-member-1' },
    },
    tenant: asTenantContext(HARNESS_TENANT),
    member: { memberId: m.memberId },
    memberId: m.memberId,
    ownContact: { contactId: m.contactId, memberId: m.memberId },
    ownContactId: m.contactId,
    sourceIp: '203.0.113.20',
    requestId: 'req-decision-1',
  };
}

/**
 * `@/lib/member-context`: a `member` session resolves to `memberCtx()`; any
 * STAFF session is handed to the REAL `requireMemberContext`, which refuses
 * it on its role check before any member read — so "a staff session → 403"
 * is asserted against the production gate, not a stub (pair with
 * `authSessionMock`, which the real gate reads the session from).
 */
export async function memberContextMock() {
  const actual = await vi.importActual<typeof import('@/lib/member-context')>('@/lib/member-context');
  return {
    requireMemberContext: async (request: NextRequest) =>
      harness.member.role === 'member' && harness.member.realGate !== true
        ? memberCtx()
        : actual.requireMemberContext(request),
  };
}

/** `@/lib/auth-session`: the session `requireMemberContext` reads — `harness.member`'s role. */
export function authSessionMock() {
  return {
    getCurrentSession: async () => ({
      user: {
        id: harness.member.userId,
        email: `${harness.member.role}@swecham.test`,
        role: harness.member.role,
        status: 'active' as const,
        displayName: harness.member.role,
      },
      session: { id: 'sess-1' },
    }),
  };
}

/** `@/lib/broadcast-marketing-deps`: the hand-off roster is `harness.marketingRoster`. */
export function marketingDepsMock() {
  return {
    makeMarketingDirectory: (): MarketingDirectoryPort => makeFakeMarketingDirectory(harness.marketingRoster),
  };
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
    makeRecordMemberDecisionDeps: () => ({
      tenant,
      broadcastsRepo: harness.store.broadcastsRepo,
      versionsRepo: harness.store.versionsRepo,
      decisionsRepo: harness.store.decisionsRepo,
      marketingDirectory: makeFakeMarketingDirectory(harness.marketingRoster),
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
  const decide = await import('@/modules/broadcasts/application/use-cases/approval/record-member-decision');
  const cancel = await import('@/modules/broadcasts/application/use-cases/cancel-broadcast');
  const reject = await import('@/modules/broadcasts/application/use-cases/reject-broadcast');
  const broadcast = await import('@/modules/broadcasts/domain/broadcast');
  const stage = await import('@/modules/broadcasts/domain/stage/broadcast-stage');
  const turn = await import('@/modules/broadcasts/domain/stage/whose-turn');
  const tenant = asTenantContext(HARNESS_TENANT);
  const clock = { now: () => harness.store.now };
  return {
    startFormattedVersion: start.startFormattedVersion,
    saveFormattedVersion: save.saveFormattedVersion,
    listBroadcastVersions: list.listBroadcastVersions,
    sendVersionToMember: send.sendVersionToMember,
    confirmSchedule: schedule.confirmSchedule,
    recordMemberDecision: decide.recordMemberDecision,
    // T081 — the widened withdrawal / rejection, over the same store, with
    // the image rows in `harness.images`.
    cancelBroadcast: cancel.cancelBroadcast,
    makeCancelBroadcastDeps: (_tenantId: string, marketingDirectory: MarketingDirectoryPort) => ({
      tenant,
      broadcastsRepo: harness.store.broadcastsRepo,
      imagesRepo: harness.images,
      audit: harness.audit,
      clock,
      marketingDirectory,
      eblastOutbox: harness.store.outbox,
    }),
    rejectBroadcast: reject.rejectBroadcast,
    makeRejectBroadcastDeps: () => ({
      tenant,
      broadcastsRepo: harness.store.broadcastsRepo,
      imagesRepo: harness.images,
      audit: harness.audit,
      clock,
    }),
    tenantDefaultLocaleFor: () => 'en',
    parseBroadcastId: broadcast.parseBroadcastId,
    stageOf: stage.stageOf,
    turnOf: turn.turnOf,
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

// --- member-side routes (T067–T081a) -----------------------------------------

export function postDecisionRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/broadcasts/${id}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function postMemberCancelRequest(id: string, body: unknown = {}): NextRequest {
  return new NextRequest(`http://localhost/api/broadcasts/${id}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function postStaffRequest(id: string, verb: 'reject' | 'cancel', body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/admin/broadcasts/${id}/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const importDecisionRoute = () => import('@/app/api/broadcasts/[id]/decision/route');
export const importMemberCancelRoute = () => import('@/app/api/broadcasts/[id]/cancel/route');
export const importStaffRejectRoute = () => import('@/app/api/admin/broadcasts/[id]/reject/route');
export const importStaffCancelRoute = () => import('@/app/api/admin/broadcasts/[id]/cancel/route');
