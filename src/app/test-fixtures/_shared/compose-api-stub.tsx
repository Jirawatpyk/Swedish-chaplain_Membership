'use client';

/**
 * Spec 122 US12d-2 follow-up — the compose fixtures' reads, stubbed in the
 * browser so the pages render as their boards draw them with no session. Test
 * routes only (`ALLOW_TEST_ROUTES`).
 *
 * - Staff (`StaffComposeApiStub`): the member picker's search and the chosen
 *   member's quota (board `Admin-broadcast-new`: 1 used, 0 reserved, 5 left
 *   of 6), plus (US12d-3) the live count (130) and the preview.
 * - Member (`MemberComposeApiStub`, US12d-3): the quota, the live count (128)
 *   and the preview (board `Proposal-compose`).
 */
import { useEffect } from 'react';
import { MEMBER_COMPOSE_SAMPLE, STAFF_COMPOSE_MEMBERS } from './compose-fixtures';

const SEARCH_PATH = '/api/admin/members/search';
const QUOTA_PATH = '/api/admin/broadcasts/quota';
const STAFF_COUNT_PATH = '/api/admin/broadcasts/recipient-count';
const STAFF_PREVIEW_PATH = '/api/admin/broadcasts/preview';
const MEMBER_QUOTA_PATH = '/api/broadcasts/quota';
const MEMBER_COUNT_PATH = '/api/broadcasts/recipient-count';
const MEMBER_ACK_PATH = '/api/portal/broadcasts/acknowledge';
const MEMBER_PREVIEW_PATH = '/api/broadcasts/preview';

const json = (body: unknown): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));

const escapeHtml = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A plain stand-in for the rendered email. Like the real wrapper
 * (`email-template.ts`), the subject is only the document's <title>, never
 * in the body: a body heading here once made a parity capture show a subject
 * that the delivered email does not have (PR K).
 */
async function previewResponse(init: RequestInit | undefined): Promise<Response> {
  const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
    subject?: string;
    bodyHtml?: string;
  };
  const html =
    `<!doctype html><html><head><title>${escapeHtml(body.subject ?? '')}</title></head>` +
    '<body style="margin:0;font-family:system-ui,sans-serif;color:#18181b">' +
    '<div style="padding:16px 20px;background:#10487a;color:#fff;font-weight:600">SweCham</div>' +
    `<div style="padding:20px">${body.bodyHtml ?? ''}</div></body></html>`;
  return json({ html });
}

/** Wraps `window.fetch` for the page's lifetime; `answer` returns null to pass through. */
function useFetchStub(answer: (url: URL, init: RequestInit | undefined) => Promise<Response> | null): void {
  useEffect(() => {
    const realFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        window.location.origin,
      );
      return answer(url, init) ?? realFetch(input, init);
    };
    return () => {
      window.fetch = realFetch;
    };
    // The answer is a pure table of fixed responses; stub once per page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function StaffComposeApiStub() {
  useFetchStub((url, init) => {
    if (url.pathname === SEARCH_PATH) {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return json({ items: STAFF_COMPOSE_MEMBERS.filter((m) => m.companyName.toLowerCase().includes(q)) });
    }
    if (url.pathname === QUOTA_PATH) {
      return json({ quotaYear: 2026, used: 1, reserved: 0, remaining: 5, cap: 6, planName: 'Premium Corporate' });
    }
    if (url.pathname === STAFF_COUNT_PATH) return json({ count: 130, ceiling: 500, exceeds: false, droppedByPreference: 0 });
    if (url.pathname === STAFF_PREVIEW_PATH) return previewResponse(init);
    return null;
  });
  return null;
}

export function MemberComposeApiStub() {
  useFetchStub((url, init) => {
    if (url.pathname === MEMBER_QUOTA_PATH) return json(MEMBER_COMPOSE_SAMPLE.quota);
    if (url.pathname === MEMBER_COUNT_PATH) return json({ count: 128, ceiling: 500, exceeds: false, droppedByPreference: 0 });
    if (url.pathname === MEMBER_PREVIEW_PATH) return previewResponse(init);
    // Spec 122 PR C — "I acknowledge" on the sending rules (`?ack=none`).
    if (url.pathname === MEMBER_ACK_PATH) return json({ acknowledgedAt: new Date().toISOString(), wasNew: true });
    return null;
  });
  return null;
}
