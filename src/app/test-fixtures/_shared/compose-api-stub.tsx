'use client';

/**
 * Spec 122 US12d-2 follow-up — the staff compose fixture's two reads, stubbed
 * in the browser: the member picker's search and the chosen member's quota
 * (board `Admin-broadcast-new`: 1 used, 0 reserved, 5 left of 6). Test routes
 * only (`ALLOW_TEST_ROUTES`).
 */
import { useEffect } from 'react';
import { STAFF_COMPOSE_MEMBERS } from './compose-fixtures';

const SEARCH_PATH = '/api/admin/members/search';
const QUOTA_PATH = '/api/admin/broadcasts/quota';

const json = (body: unknown): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));

export function StaffComposeApiStub() {
  useEffect(() => {
    const realFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        window.location.origin,
      );
      if (url.pathname === SEARCH_PATH) {
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        return json({ items: STAFF_COMPOSE_MEMBERS.filter((m) => m.companyName.toLowerCase().includes(q)) });
      }
      if (url.pathname === QUOTA_PATH) {
        return json({ quotaYear: 2026, used: 1, reserved: 0, remaining: 5, cap: 6, planName: 'Premium Corporate' });
      }
      return realFetch(input, init);
    };
    return () => {
      window.fetch = realFetch;
    };
  }, []);
  return null;
}
