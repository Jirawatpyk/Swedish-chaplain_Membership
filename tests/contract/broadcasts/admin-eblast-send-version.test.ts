/**
 * F119 T040 · T043 · T059 — `POST /api/admin/broadcasts/[id]/version/send`
 * (US1-AS2, FR-003, FR-004, FR-011, FR-024, FR-026; contracts
 * admin-eblast-formatting-api.md § send, dashboard-and-notifications.md
 * §§ 2–3).
 *
 * Sending a version makes it read-only, moves the stage to the member's turn,
 * starts a round (the ONLY place `current_round` moves), resets the reminder
 * clock and enqueues ONE outbox row to the member's portal contact in the
 * contact's language — inside the same transaction as the state change, so a
 * failure after the enqueue leaves no row behind.
 *
 * The REAL `sendVersionToMember` runs through the route over the in-memory
 * approval store (whose outbox rows roll back with it).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { makeApprovalBroadcast, makeApprovalVersion, makePortalContact, FAKE_TX } from '../../helpers/eblast-approval-fakes';
import {
  HARNESS_MEMBER_ID,
  harness,
  importSendRoute,
  importVersionRoute,
  patchVersionRequest,
  postSendRequest,
  postVersionRequest,
  resetVersionHarness,
  routeParams,
} from '../../helpers/eblast-version-route-harness';

vi.mock('@/lib/rbac', async () => (await import('../../helpers/eblast-version-route-harness')).rbacMock());
vi.mock('@/lib/tenant-context', async () => (await import('../../helpers/eblast-version-route-harness')).tenantContextMock());
vi.mock('@/lib/logger', async () => (await import('../../helpers/eblast-version-route-harness')).loggerMock());
vi.mock('@/lib/broadcast-approval-deps', async () =>
  (await import('../../helpers/eblast-version-route-harness')).approvalDepsMock(),
);
vi.mock('@/modules/broadcasts', async () =>
  (await import('../../helpers/eblast-version-route-harness')).broadcastsBarrelMock(),
);

const V0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
const WORKING = makeApprovalVersion({ versionNo: 1, noteToMember: 'Tightened the intro.', updatedAt: new Date('2026-09-24T08:30:00Z') });
const IN_DESIGN = makeApprovalBroadcast({
  status: 'in_design',
  currentRound: 0,
  // Non-zero on purpose: the send must RESET the reminder clock.
  memberReminderStage: 2,
  memberExpiryNotifiedAt: new Date('2026-09-22T00:00:00Z'),
  stageEnteredAt: new Date('2026-09-23T08:00:00Z'),
});
const ID = IN_DESIGN.broadcastId as string;
const rowOf = () => harness.store.state.broadcasts.get(`test-tenant::${ID}`)!;
const versionOf = (versionNo: number) => harness.store.versionsRepo.rows().find((v) => v.versionNo === versionNo)!;

beforeEach(() => {
  resetVersionHarness({ broadcasts: [IN_DESIGN], versions: [V0, WORKING] });
});

async function send(id = ID) {
  const { POST } = await importSendRoute();
  return POST(postSendRequest(id), routeParams(id));
}

describe('POST …/version/send — the version goes to the member (T040, US1-AS2)', () => {
  it('stage = awaiting_member_approval, round incremented, the clock reset, one member outbox row in the member\'s language', async () => {
    const res = await send();

    expect(res.status).toBe(200);
    const now = harness.store.now;
    expect(await res.json()).toEqual({
      status: 'awaiting_member_approval',
      whoseTurn: 'member',
      round: 1,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(rowOf()).toMatchObject({
      status: 'awaiting_member_approval',
      currentRound: 1,
      stageEnteredAt: now,
      memberReminderStage: 0,
      memberExpiryNotifiedAt: null,
    });
    // The version is now read-only: it carries its send stamp.
    expect(versionOf(1).sentToMemberAt).toEqual(now);

    expect(harness.store.outbox.rows()).toEqual([
      {
        tx: FAKE_TX,
        tenantId: 'test-tenant',
        type: 'eblast_version_sent_member',
        toEmail: 'owner@acme.test',
        locale: 'th',
        contextData: { tenantId: 'test-tenant', broadcastId: ID, versionId: WORKING.id, round: 1 },
      },
    ]);

    const sent = harness.audit.events.filter((e) => e.eventType === 'broadcast_version_sent_to_member');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.tx).toBe(FAKE_TX);
    expect(sent[0]!.payload).toEqual({
      related_member_id: HARNESS_MEMBER_ID,
      broadcast_id: ID,
      version_id: WORKING.id,
      round: 1,
      note_length: 'Tightened the intro.'.length,
      notified: true,
      actor_role: 'marketing',
    });
  });

  it('PATCH after send → 409 stage_changed: marketing can no longer edit the version the member is looking at', async () => {
    expect((await send()).status).toBe(200);
    const { PATCH } = await importVersionRoute();
    const res = await PATCH(
      patchVersionRequest(ID, {
        subject: 'Sneaky edit',
        bodyHtml: '<p>Sneaky</p>',
        bodySource: '{}',
        noteToMember: null,
        expectedUpdatedAt: harness.store.now.toISOString(),
      }),
      routeParams(ID),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('stage_changed');
    expect(versionOf(1).subject).toBe(WORKING.subject);
  });

  it('the member contact who submitted is emailed first, in their own language (FR-024)', async () => {
    harness.portalContacts = {
      [HARNESS_MEMBER_ID]: [
        makePortalContact({ contactId: 'dddddddd-0000-4000-8000-000000000009', email: 'primary@acme.test', locale: 'en', linkedUserId: '99999999-9999-4999-8999-999999999999', isPrimary: true }),
        makePortalContact({ contactId: 'dddddddd-0000-4000-8000-000000000002', email: 'submitter@acme.test', locale: 'sv', linkedUserId: IN_DESIGN.submittedByUserId, isPrimary: false }),
      ],
    };
    expect((await send()).status).toBe(200);
    expect(harness.store.outbox.rows().map((r) => [r.toEmail, r.locale])).toEqual([['submitter@acme.test', 'sv']]);
  });
});

// F119 round-4 B1 (FR-033, the "two marketing users" edge case) — the send
// takes the save's concurrency token. Marketing user B, with a clean but stale
// screen, used to send the content user A had just saved — content B never
// saw. B is now told the E-Blast changed, exactly as a stale save is.
describe('round-4 B1 — the send checks expectedUpdatedAt under the lock', () => {
  const sendWith = async (body: unknown) => {
    const { POST } = await importSendRoute();
    return POST(postSendRequest(ID, body), routeParams(ID));
  };

  it('A saves, then B sends with the token B loaded → 409 version_changed with the current copy; nothing is sent', async () => {
    const loaded = WORKING.updatedAt.toISOString();
    const { PATCH } = await importVersionRoute();
    const saved = await PATCH(
      patchVersionRequest(ID, { subject: 'Anna rewrote it', bodyHtml: '<p>Anna</p>', bodySource: '<p>Anna</p>', noteToMember: null, expectedUpdatedAt: loaded }),
      routeParams(ID),
    );
    expect(saved.status).toBe(200);
    const annaToken = (await saved.json()).version.updatedAt as string;

    const res = await sendWith({ expectedUpdatedAt: loaded });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('version_changed');
    expect(body.error.details).toEqual({
      currentUpdatedAt: annaToken,
      current: { subject: 'Anna rewrote it', bodyHtml: '<p>Anna</p>', bodySource: '<p>Anna</p>', noteToMember: null },
    });
    expect(versionOf(1).sentToMemberAt).toBeNull();
    expect(rowOf().status).toBe('in_design');
    expect(harness.store.outbox.rows()).toHaveLength(0);
    expect(harness.audit.events.filter((e) => e.eventType === 'broadcast_version_sent_to_member')).toHaveLength(0);

    // With the token A's save returned, the send goes through.
    const retry = await sendWith({ expectedUpdatedAt: annaToken });
    expect(retry.status).toBe(200);
    expect(versionOf(1).sentToMemberAt).toEqual(harness.store.now);
  });

  it('the token of the copy under the lock → 200', async () => {
    expect((await sendWith({ expectedUpdatedAt: WORKING.updatedAt.toISOString() })).status).toBe(200);
  });

  it.each([
    ['not an ISO date-time', { expectedUpdatedAt: 'yesterday' }],
    ['not a string', { expectedUpdatedAt: 42 }],
  ])('an expectedUpdatedAt that is %s → 400 invalid_body, nothing sent', async (_label, body) => {
    const res = await sendWith(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
    expect(versionOf(1).sentToMemberAt).toBeNull();
  });

  it('a body that is not JSON → 400 invalid_body, nothing sent', async () => {
    const { POST } = await importSendRoute();
    const req = new NextRequest(`http://localhost/api/admin/broadcasts/${ID}/version/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(req, routeParams(ID));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
    expect(versionOf(1).sentToMemberAt).toBeNull();
  });
});

describe('T043 — a member company with no active portal user', () => {
  it('→ 409 no_portal_user and no stage change: nothing sent, nothing enqueued, nothing audited', async () => {
    harness.portalContacts = {};
    const res = await send();

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('no_portal_user');
    expect(rowOf()).toEqual(IN_DESIGN);
    expect(versionOf(1).sentToMemberAt).toBeNull();
    expect(harness.store.outbox.rows()).toHaveLength(0);
    expect(harness.audit.events).toHaveLength(0);
  });
});

describe('T059 — FR-011: re-sending unchanged content is a new round', () => {
  it('a version byte-identical to the previous round is accepted as round N+1', async () => {
    const V1_SENT = makeApprovalVersion({ versionNo: 1, sentToMemberAt: new Date('2026-09-21T08:00:00Z') });
    resetVersionHarness({
      broadcasts: [makeApprovalBroadcast({ status: 'changes_requested', currentRound: 1 })],
      versions: [V0, V1_SENT],
    });
    const { POST } = await importVersionRoute();
    expect((await POST(postVersionRequest(ID), routeParams(ID))).status).toBe(201);

    const res = await send();
    expect(res.status).toBe(200);
    expect((await res.json()).round).toBe(2);
    const v2 = versionOf(2);
    expect([v2.subject, v2.bodyHtml, v2.bodySource]).toEqual([V1_SENT.subject, V1_SENT.bodyHtml, V1_SENT.bodySource]);
    expect(v2.sentToMemberAt).toEqual(harness.store.now);
    expect(rowOf()).toMatchObject({ status: 'awaiting_member_approval', currentRound: 2 });
  });
});

describe('FR-004 — the content rules apply again at the moment of sending', () => {
  it('a working copy that breaks a block rule → 422 with the block code; the version stays editable and unsent', async () => {
    const cta = `<a data-eb="cta" href="https://swecham.example/join">${'x'.repeat(61)}</a>`;
    resetVersionHarness({ broadcasts: [IN_DESIGN], versions: [V0, { ...WORKING, bodyHtml: `<p>x</p>${cta}` }] });
    const res = await send();
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('cta_text_length');
    expect(rowOf().status).toBe('in_design');
    expect(versionOf(1).sentToMemberAt).toBeNull();
  });

  it('a working copy with nothing left after sanitising → 422 unsafe_content (the save\'s own code for the same rule)', async () => {
    resetVersionHarness({ broadcasts: [IN_DESIGN], versions: [V0, { ...WORKING, bodyHtml: '<script>alert(1)</script>' }] });
    const res = await send();
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('unsafe_content');
    expect(rowOf().status).toBe('in_design');
  });

  it('a blank subject on the working copy → 422 validation_error', async () => {
    resetVersionHarness({ broadcasts: [IN_DESIGN], versions: [V0, { ...WORKING, subject: '   ' }] });
    const res = await send();
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('validation_error');
  });
});

describe('the stage and the rows are re-read under the lock', () => {
  it('a row not in in_design → 409 stage_changed; in_design with no working copy → 409 no_working_copy', async () => {
    resetVersionHarness({ broadcasts: [makeApprovalBroadcast({ status: 'submitted' })] });
    const submitted = await send();
    expect(submitted.status).toBe(409);
    expect((await submitted.json()).error.code).toBe('stage_changed');

    resetVersionHarness({ broadcasts: [IN_DESIGN], versions: [V0] });
    const bare = await send();
    expect(bare.status).toBe(409);
    expect((await bare.json()).error.code).toBe('no_working_copy');
  });

  it('an unknown / other-tenant id → 404 with the probe audited; a malformed id → 404 before any read', async () => {
    const res = await send('99999999-9999-4999-8999-999999999999');
    expect(res.status).toBe(404);
    expect(harness.audit.events.map((e) => e.eventType)).toEqual(['broadcast_cross_tenant_probe']);

    const malformed = await send('not-a-uuid');
    expect(malformed.status).toBe(404);
    expect(harness.store.broadcastsRepo.findByIdInTx).toHaveBeenCalledTimes(1);
  });
});

describe('SC-004 — the outbox row rides the state-changing transaction', () => {
  it('a failure after the enqueue rolls the row back with the transition: no row, no send stamp, still in_design', async () => {
    harness.store.outbox.enqueueInTx.mockImplementationOnce(async (tx, tenant, request) => {
      harness.store.state.outbox = [...harness.store.state.outbox, { ...request, tx, tenantId: tenant.slug as string }];
      throw new Error('connection reset after the INSERT');
    });
    const res = await send();

    expect(res.status).toBe(500);
    expect(harness.store.outbox.rows()).toHaveLength(0);
    expect(rowOf()).toEqual(IN_DESIGN);
    expect(versionOf(1).sentToMemberAt).toBeNull();
  });
});
