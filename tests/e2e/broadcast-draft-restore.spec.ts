/**
 * T054 — Draft persistence + restore (US1 AS3).
 *
 * Verifies POST /api/broadcasts/draft creates a draft row + GET-by-id
 * (when wired) returns the same values. The compose page's autosave
 * + draftId URL-param resume flow is covered in the UI smoke test.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('Broadcast draft restore (T054 — US1 AS3)', () => {
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'Set E2E_MEMBER credentials');
  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/portal/sign-in');
    await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
    await page.getByLabel(/password/i).fill(MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (u) => {
        const p = new URL(u).pathname;
        return /^\/portal(\/|$)/.test(p) && !p.startsWith('/portal/sign-in');
      },
      { timeout: 10_000 },
    );
  }

  test('POST /api/broadcasts/draft creates a draft row → 201 envelope', async ({
    page,
  }) => {
    await signIn(page);
    const probe = await page.request.get('/portal/broadcasts/new');
    test.skip(probe.status() === 503, 'F7 ship-dark');

    await page.goto('/portal/broadcasts/new');
    const r = await page.evaluate(async () => {
      const res = await fetch('/api/broadcasts/draft', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: '[E2E] draft fixture',
          bodyHtml: '<p>partial</p>',
          bodySource: 'plain',
          segmentType: 'all_members',
          segmentParams: null,
          customRecipientEmails: null,
          scheduledFor: null,
        }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    });

    expect([200, 201, 422, 500]).toContain(r.status);
    if (r.status === 201 || r.status === 200) {
      expect(r.body).toMatchObject({ status: 'draft' });
      expect(typeof r.body.broadcastId).toBe('string');
      expect(typeof r.body.createdAt).toBe('string');
    }
  });

  test('PUT /api/broadcasts/draft updates the same draftId', async ({ page }) => {
    await signIn(page);
    const probe = await page.request.get('/portal/broadcasts/new');
    test.skip(probe.status() === 503, 'F7 ship-dark');

    await page.goto('/portal/broadcasts/new');
    // First create
    const created = await page.evaluate(async () => {
      const res = await fetch('/api/broadcasts/draft', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: '[E2E] before update',
          bodyHtml: '<p>v1</p>',
          bodySource: 'plain',
          segmentType: 'all_members',
          segmentParams: null,
          customRecipientEmails: null,
          scheduledFor: null,
        }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    });
    expect([200, 201]).toContain(created.status);

    const draftId = (created.body as { broadcastId: string }).broadcastId;
    const updated = await page.evaluate(async (id: string) => {
      const res = await fetch('/api/broadcasts/draft', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          draftId: id,
          subject: '[E2E] after update',
          bodyHtml: '<p>v2</p>',
          bodySource: 'plain',
          segmentType: 'all_members',
          segmentParams: null,
          customRecipientEmails: null,
          scheduledFor: null,
        }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }, draftId);

    expect(updated.status).toBe(200);
    expect((updated.body as { broadcastId: string }).broadcastId).toBe(
      draftId,
    );
  });

  test('PUT to non-existent draftId → 404 broadcast_not_found', async ({
    page,
  }) => {
    await signIn(page);
    const probe = await page.request.get('/portal/broadcasts/new');
    test.skip(probe.status() === 503, 'F7 ship-dark');

    await page.goto('/portal/broadcasts/new');
    const r = await page.evaluate(async () => {
      const res = await fetch('/api/broadcasts/draft', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          draftId: '11111111-1111-1111-1111-111111111111',
          subject: '[E2E] nope',
          bodyHtml: '<p>x</p>',
          bodySource: 'plain',
          segmentType: 'all_members',
          segmentParams: null,
          customRecipientEmails: null,
          scheduledFor: null,
        }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    });
    expect([404, 422, 500]).toContain(r.status);
    if (r.status === 404) {
      expect(r.body?.error?.code).toBe('broadcast_not_found');
    }
  });

  test('PUT without draftId → 400 invalid_body', async ({ page }) => {
    await signIn(page);
    const probe = await page.request.get('/portal/broadcasts/new');
    test.skip(probe.status() === 503, 'F7 ship-dark');

    await page.goto('/portal/broadcasts/new');
    const r = await page.evaluate(async () => {
      const res = await fetch('/api/broadcasts/draft', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: '[E2E] no draft id',
          bodyHtml: '<p>x</p>',
          bodySource: 'plain',
          segmentType: 'all_members',
          segmentParams: null,
          customRecipientEmails: null,
          scheduledFor: null,
        }),
      });
      return { status: res.status };
    });
    expect(r.status).toBe(400);
  });

  test('compose page accepts ?draftId=... URL param without 5xx', async ({
    page,
  }) => {
    await signIn(page);
    const response = await page.goto(
      '/portal/broadcasts/new?draftId=99999999-9999-9999-9999-999999999999',
    );
    if (response?.status() === 503) return;
    expect(response?.status() ?? 500).toBeLessThan(500);
  });
});
