/**
 * F119 T106 / T107 / T146 — `authorizeImageOwner`: who may attach an image to
 * what (FR-040, US3-AS3, US6-AS7).
 *
 *   member  → the caller's OWN member's `draft` (the existing member upload
 *             route had `draftId` as an unvalidated form string — this is the
 *             real check). Another member's row in the same tenant → 404 +
 *             `broadcast_cross_member_probe`; an unknown / other-tenant id →
 *             404 + `broadcast_cross_tenant_probe` (never 403 — no
 *             existence leak); a closed broadcast → 409.
 *   staff   → a broadcast in the accepted stage set (PR-1: draft, submitted;
 *             T106a widens to in_design), same tenant; a miss → 404 + probe;
 *             a closed one → 409. Returns the owning member for the audit's
 *             `related_member_id`.
 *   template→ an existing template of the tenant; a miss → 404 + the
 *             template probe.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MemberId } from '@/modules/members';
import { authorizeImageOwner } from '@/modules/broadcasts/application/use-cases/authorize-image-owner';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';

const TENANT = 'tenant-swe' as never;
const BID = '11111111-1111-1111-1111-111111111111';
const MEMBER = '22222222-2222-2222-2222-222222222222' as MemberId;
const OTHER = '33333333-3333-3333-3333-333333333333' as MemberId;

function broadcast(status: string, requestedByMemberId = MEMBER) {
  return { broadcastId: BID, status, requestedByMemberId } as never;
}

function makeDeps(o: {
  owned?: 'owned' | 'not_found' | 'cross_member';
  status?: string;
  byId?: 'found' | 'missing';
  template?: 'found' | 'missing';
} = {}) {
  const audit: AuditPort & { events: Array<{ eventType: string; payload: Record<string, unknown> }> } = {
    events: [],
    async emit(_tx, e) {
      audit.events.push({ eventType: e.eventType, payload: e.payload });
    },
    async emitTyped(_tx, e) {
      audit.events.push({ eventType: e.eventType, payload: e.payload as Record<string, unknown> });
    },
  };
  const status = o.status ?? 'draft';
  return {
    audit,
    deps: {
      tenant: { slug: TENANT } as never,
      broadcastsRepo: {
        findOwnedByMember: vi.fn(async () =>
          o.owned === 'cross_member'
            ? { probeKind: 'cross_member', broadcast: null }
            : o.owned === 'not_found'
              ? { probeKind: 'not_found', broadcast: null }
              : { probeKind: 'owned', broadcast: broadcast(status) },
        ),
        findById: vi.fn(async () => (o.byId === 'missing' ? null : broadcast(status, OTHER))),
      } as never,
      templates: { findById: vi.fn(async () => (o.template === 'missing' ? null : { id: BID })) } as never,
      audit,
    },
  };
}

const base = { tenantId: TENANT, actorUserId: 'u1', requestId: 'r1' };

describe('authorizeImageOwner — member', () => {
  it('own draft → ok with related member = the caller', async () => {
    const { deps } = makeDeps();
    const r = await authorizeImageOwner(deps, { ...base, owner: { kind: 'broadcast', id: BID }, actor: { kind: 'member', memberId: MEMBER } });
    expect(r).toEqual({ ok: true, value: { relatedMemberId: MEMBER } });
  });

  it('another member\'s draft → not_found + broadcast_cross_member_probe (never 403)', async () => {
    const { deps, audit } = makeDeps({ owned: 'cross_member' });
    const r = await authorizeImageOwner(deps, { ...base, owner: { kind: 'broadcast', id: BID }, actor: { kind: 'member', memberId: MEMBER } });
    expect(r).toEqual({ ok: false, error: { kind: 'not_found' } });
    expect(audit.events.map((e) => e.eventType)).toEqual(['broadcast_cross_member_probe']);
    // F2-5: the TYPED shape (audit-port `F7AuditPayloadShapes`) and the sibling
    // emitter (`snapshot-template-to-draft`) both use camelCase here, and they do
    // so DELIBERATELY: `member_id` is the one key the 0009 `last_activity_at`
    // SECURITY DEFINER trigger reads, so a snake_case key on a REFUSED probe
    // would refresh the probed member's recency off an attacker's request.
    expect(audit.events[0]!.payload).toMatchObject({
      probedMemberId: MEMBER,
      probedBroadcastId: BID,
      operation: 'image_upload',
    });
  });

  it('the cross-member probe payload carries NO snake_case member_id (the last_activity_at trigger key)', async () => {
    const { deps, audit } = makeDeps({ owned: 'cross_member' });
    await authorizeImageOwner(deps, { ...base, owner: { kind: 'broadcast', id: BID }, actor: { kind: 'member', memberId: MEMBER } });
    const payload = audit.events[0]!.payload;
    expect(Object.keys(payload)).not.toContain('member_id');
    expect(Object.keys(payload)).not.toContain('broadcast_id');
  });

  it('an unknown id → not_found + broadcast_cross_tenant_probe (RLS hides the other tenant\'s row)', async () => {
    const { deps, audit } = makeDeps({ owned: 'not_found' });
    const r = await authorizeImageOwner(deps, { ...base, owner: { kind: 'broadcast', id: BID }, actor: { kind: 'member', memberId: MEMBER } });
    expect(r).toEqual({ ok: false, error: { kind: 'not_found' } });
    expect(audit.events.map((e) => e.eventType)).toEqual(['broadcast_cross_tenant_probe']);
  });

  it('a closed (non-draft) broadcast → closed with its status; a submitted one is closed to the MEMBER too', async () => {
    for (const status of ['submitted', 'sent', 'cancelled']) {
      const { deps } = makeDeps({ status });
      const r = await authorizeImageOwner(deps, { ...base, owner: { kind: 'broadcast', id: BID }, actor: { kind: 'member', memberId: MEMBER } });
      expect(r).toEqual({ ok: false, error: { kind: 'closed', status } });
    }
  });
});

describe('authorizeImageOwner — staff', () => {
  it('a draft or submitted broadcast → ok with the owning member as related member (PR-1 stage set)', async () => {
    for (const status of ['draft', 'submitted']) {
      const { deps } = makeDeps({ status });
      const r = await authorizeImageOwner(deps, { ...base, owner: { kind: 'broadcast', id: BID }, actor: { kind: 'staff' } });
      expect(r).toEqual({ ok: true, value: { relatedMemberId: OTHER } });
    }
  });

  it('a closed broadcast → closed; an approved one → closed (a sent version is read-only)', async () => {
    for (const status of ['approved', 'sent', 'rejected']) {
      const { deps } = makeDeps({ status });
      const r = await authorizeImageOwner(deps, { ...base, owner: { kind: 'broadcast', id: BID }, actor: { kind: 'staff' } });
      expect(r).toEqual({ ok: false, error: { kind: 'closed', status } });
    }
  });

  it('another tenant\'s id → not_found + broadcast_cross_tenant_probe', async () => {
    const { deps, audit } = makeDeps({ byId: 'missing' });
    const r = await authorizeImageOwner(deps, { ...base, owner: { kind: 'broadcast', id: BID }, actor: { kind: 'staff' } });
    expect(r).toEqual({ ok: false, error: { kind: 'not_found' } });
    expect(audit.events.map((e) => e.eventType)).toEqual(['broadcast_cross_tenant_probe']);
  });
});

describe('authorizeImageOwner — template', () => {
  it('an existing template → ok with no related member', async () => {
    const { deps } = makeDeps();
    const r = await authorizeImageOwner(deps, { ...base, owner: { kind: 'template', id: BID }, actor: { kind: 'staff' } });
    expect(r).toEqual({ ok: true, value: { relatedMemberId: null } });
  });

  it('a missing template → not_found + the template probe audit', async () => {
    const { deps, audit } = makeDeps({ template: 'missing' });
    const r = await authorizeImageOwner(deps, { ...base, owner: { kind: 'template', id: BID }, actor: { kind: 'staff' } });
    expect(r).toEqual({ ok: false, error: { kind: 'not_found' } });
    expect(audit.events.map((e) => e.eventType)).toEqual(['broadcast_cross_tenant_probe']);
    expect(audit.events[0]!.payload).toMatchObject({ resourceKind: 'template', probedTemplateId: BID });
  });

  it('a member may not attach to a template', async () => {
    const { deps } = makeDeps();
    const r = await authorizeImageOwner(deps, { ...base, owner: { kind: 'template', id: BID }, actor: { kind: 'member', memberId: MEMBER } });
    expect(r).toEqual({ ok: false, error: { kind: 'not_found' } });
  });
});
