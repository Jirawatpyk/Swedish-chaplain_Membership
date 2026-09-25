/**
 * F119 T058 — the formatted version passes the SAME content rules as a
 * member's, at every save (FR-004, FR-006, FR-040, FR-041), and a violation
 * is 422 with the version NOT saved.
 *
 * `PATCH /api/admin/broadcasts/[id]/version` over the REAL
 * `saveFormattedVersion`, the REAL shared sanitiser (DOMPurify + the one
 * content policy) and the design-block rules; the image allow-list is a fake
 * holding one host.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { broadcastsMetrics } from '@/lib/metrics';
import { makeApprovalBroadcast, makeApprovalVersion } from '../../helpers/eblast-approval-fakes';
import {
  harness,
  importVersionRoute,
  patchVersionRequest,
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

const IN_DESIGN = makeApprovalBroadcast({ status: 'in_design' });
const ID = IN_DESIGN.broadcastId as string;
const TOKEN = new Date('2026-09-24T08:30:00.000Z');
const V0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
const WORKING = makeApprovalVersion({ versionNo: 1, updatedAt: TOKEN });
const HOST = 'assets.swecham.zyncdata.app';

const cta = (text: string, href = 'https://swecham.example/join') => `<a data-eb="cta" href="${href}">${text}</a>`;
const save = (patch: Record<string, unknown>) => ({
  subject: 'Formatted subject',
  bodyHtml: '<p>Formatted body</p>',
  bodySource: '{"type":"doc"}',
  noteToMember: null,
  expectedUpdatedAt: TOKEN.toISOString(),
  ...patch,
});

async function patch(body: Record<string, unknown>) {
  const { PATCH } = await importVersionRoute();
  return PATCH(patchVersionRequest(ID, save(body)), routeParams(ID));
}

function expectNotSaved() {
  expect(harness.store.versionsRepo.rows()[1]).toEqual(WORKING);
  expect(harness.store.versionsRepo.updateWorkingCopy).not.toHaveBeenCalled();
  expect(broadcastsMetrics.versionSaved).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetVersionHarness({ broadcasts: [IN_DESIGN], versions: [V0, WORKING] });
  vi.spyOn(broadcastsMetrics, 'versionSaved');
});

describe('PATCH /api/admin/broadcasts/[id]/version — content rules at every save (FR-004)', () => {
  it('61-character CTA text → 422 cta_text_length', async () => {
    const res = await patch({ bodyHtml: `<p>x</p>${cta('x'.repeat(61))}` });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('cta_text_length');
    expectNotSaved();
  });

  it('a 4th CTA → 422 too_many_cta', async () => {
    const res = await patch({ bodyHtml: `${cta('One')}${cta('Two')}${cta('Three')}${cta('Four')}` });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('too_many_cta');
    expectNotSaved();
  });

  it('`javascript:` in a CTA link → 422 cta_link_scheme', async () => {
    const res = await patch({ bodyHtml: `<p>x</p>${cta('Go', 'javascript:alert(1)')}` });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('cta_link_scheme');
    expectNotSaved();
  });

  it('a banner without a description → 422 banner_alt_required', async () => {
    const res = await patch({ bodyHtml: `<p>x</p><img data-eb="banner" src="https://${HOST}/b.png">` });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('banner_alt_required');
    expectNotSaved();
  });

  it('a 1,001-character noteToMember → 422 validation_error while a 1,000-character one is accepted', async () => {
    const over = await patch({ noteToMember: 'n'.repeat(1001) });
    expect(over.status).toBe(422);
    const body = await over.json();
    expect(body.error.code).toBe('validation_error');
    expect(body.error.fieldErrors).toHaveProperty('noteToMember');
    expectNotSaved();

    const atCap = await patch({ noteToMember: 'n'.repeat(1000) });
    expect(atCap.status).toBe(200);
    expect(harness.store.versionsRepo.rows()[1]!.noteToMember).toHaveLength(1000);
  });

  it('a subject over 200 characters → 422 validation_error naming the subject', async () => {
    const res = await patch({ subject: 's'.repeat(201) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
    expect(body.error.fieldErrors).toEqual({ subject: ['too_long'] });
    expectNotSaved();
  });

  it('an image whose host is off the tenant allow-list → 422 image_source_not_allowlisted naming the image', async () => {
    const src = 'https://elsewhere.example/p.png';
    const res = await patch({ bodyHtml: `<p>x</p><img src="${src}" alt="A photo">` });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('image_source_not_allowlisted');
    expect(body.error.details).toEqual({ images: [src] });
    expectNotSaved();
  });

  it('a body the sanitiser leaves empty → 422 unsafe_content', async () => {
    const res = await patch({ bodyHtml: '<script>alert(1)</script>' });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('unsafe_content');
    expectNotSaved();
  });

  it('a compliant body (3 CTAs, a described banner on an allow-listed host) saves the SANITISED html and counts the save', async () => {
    const counted = vi.mocked(broadcastsMetrics.versionSaved);
    const bodyHtml = `${cta('One')}${cta('Two')}${cta('Three')}<img data-eb="banner" src="https://${HOST}/b.png" alt="Spring event"><p onclick="x()">Hi</p>`;
    const res = await patch({ bodyHtml, noteToMember: 'Tightened the intro.' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: { id: WORKING.id, versionNo: 1 }, unsafeImageSources: [] });
    const stored = harness.store.versionsRepo.rows()[1]!;
    expect(stored.bodyHtml).not.toContain('onclick');
    expect(stored.bodyHtml).toContain('data-eb="banner"');
    expect(stored.noteToMember).toBe('Tightened the intro.');
    // A save is not a hand-off: no audit row — a counter instead.
    expect(harness.audit.events).toHaveLength(0);
    expect(counted).toHaveBeenCalledWith('test-tenant');
  });
});
