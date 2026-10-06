'use client';

/**
 * 122 US9a (T906) — answers the relink dialog's member search from a fixture,
 * so the `relink open` preview shows results; every other request goes to the
 * network. Restores `fetch` on unmount.
 */
import { useEffect } from 'react';

const MEMBER_SEARCH_PATH = '/api/admin/members/search';

export function MemberSearchStub({
  hits,
}: {
  readonly hits: ReadonlyArray<{ memberId: string; companyName: string; primaryContactName: string | null }>;
}) {
  useEffect(() => {
    const realFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        window.location.origin,
      );
      if (url.pathname !== MEMBER_SEARCH_PATH) return realFetch(input, init);
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const items = hits.filter((h) => h.companyName.toLowerCase().includes(q));
      return Promise.resolve(
        new Response(JSON.stringify({ items }), { headers: { 'content-type': 'application/json' } }),
      );
    };
    return () => {
      window.fetch = realFetch;
    };
  }, [hits]);
  return null;
}
