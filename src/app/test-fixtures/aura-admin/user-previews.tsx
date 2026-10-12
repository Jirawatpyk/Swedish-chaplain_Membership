'use client';

/**
 * 122 US10a (T1007) — preview helpers for `/admin/users`: answers the invite
 * dialog's member search from a fixture (every other request goes to the
 * network; `fetch` is restored on unmount), and picks Super Admin in the
 * open change-role dialog so the promotion state can be compared with the
 * `Admin-user-role` board.
 */
import { useEffect } from 'react';

const MEMBERS_PATH = '/api/members';

export function MembersApiStub({
  rows,
}: {
  readonly rows: ReadonlyArray<{ member_id: string; company_name: string; country: string; status: string }>;
}) {
  useEffect(() => {
    const realFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        window.location.origin,
      );
      if (url.pathname !== MEMBERS_PATH) return realFetch(input, init);
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const items = rows.filter((r) => r.company_name.toLowerCase().includes(q));
      return Promise.resolve(
        new Response(JSON.stringify({ items }), { headers: { 'content-type': 'application/json' } }),
      );
    };
    return () => {
      window.fetch = realFetch;
    };
  }, [rows]);
  return null;
}

/** Once a dialog is open, picks its radio with this value (for up to 5 s). */
export function PickRadioInDialog({ value }: { readonly value: string }) {
  useEffect(() => {
    let tries = 0;
    const id = window.setInterval(() => {
      const radio = document.querySelector<HTMLInputElement>(`[role="alertdialog"] input[type="radio"][value="${value}"]`);
      if (radio) radio.click();
      if (radio || ++tries > 50) window.clearInterval(id);
    }, 100);
    return () => window.clearInterval(id);
  }, [value]);
  return null;
}
