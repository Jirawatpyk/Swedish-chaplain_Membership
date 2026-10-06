'use client';

/**
 * 122 US9a (T906) — answers the relink dialog's member search from a fixture,
 * so the `relink open` preview shows results; every other request goes to the
 * network. Restores `fetch` on unmount.
 */
import { useEffect, useRef, type ReactNode } from 'react';

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

/**
 * 122 US9b-1 (T928) — opens the first attendee row's ⋯ menu and chooses
 * "Erase personal data", so the `dialog=erase` preview shows the erase dialog
 * as the row menu opens it. Retries until the dialog is open, for up to 5 s.
 */
export function OpenRowEraseMenu({ children }: { readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let tries = 0;
    const id = window.setInterval(() => {
      const root = ref.current;
      if (!root || document.querySelector('[role="alertdialog"]') || ++tries > 50) {
        window.clearInterval(id);
        return;
      }
      const item = document.querySelector<HTMLElement>('[role="menuitem"]');
      if (item) item.click();
      else root.querySelector<HTMLButtonElement>('[data-testid^="attendee-more-"]')?.click();
    }, 100);
    return () => window.clearInterval(id);
  }, []);
  return <div ref={ref}>{children}</div>;
}
