'use client';

/**
 * 122 US9a (T906) — answers the relink dialog's member search from a fixture,
 * so the `relink open` preview shows results; every other request goes to the
 * network. Restores `fetch` on unmount.
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

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

/**
 * 122 US9b-2 (T939) — drives the CSV import form into a state for the
 * `view=import` previews, with no session and no DB: answers the events
 * list from a fixture, picks a CSV file for the form and, for the
 * submitted states, answers the import POST (`mismatch` → the event-mismatch
 * warning, `result` → a completed import). `dialog=create` opens the
 * inline create dialog. Restores `fetch` on unmount.
 */
export function ImportPreviewDriver({
  events,
  state,
  dialog,
  children,
}: {
  readonly events: ReadonlyArray<{ eventId: string; name: string; startDate: string }>;
  readonly state: 'idle' | 'preview' | 'remap' | 'error' | 'mismatch' | 'result';
  readonly dialog: 'create' | null;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // A layout effect, so the stub is in place before the picker's own
  // (passive) mount effect fetches the events list.
  useLayoutEffect(() => {
    const realFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        window.location.origin,
      );
      const json = (body: unknown) =>
        Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
      if (url.pathname === '/api/admin/events' && (init?.method ?? 'GET') === 'GET') {
        return json({ items: events });
      }
      if (url.pathname === '/api/admin/events/import') {
        return state === 'mismatch'
          ? json({
              kind: 'event_mismatch_warning',
              priorImports: [
                { recordId: 'rec-1', eventId: 'Midsummer Celebration 2026', uploadedAt: '2026-06-22T04:10:00Z' },
              ],
            })
          : json({
              kind: 'completed',
              recordId: '5f1c2a9e-3b7d-4c11-9e0a-7d2b6c8e4f10',
              summary: {
                rowsProcessed: 146,
                rowsAlreadyImported: 2,
                eventsCreated: 0,
                eventsUpdated: 1,
                matchCounts: { member_contact: 98, member_domain: 14, member_fuzzy: 9, non_member: 21, unmatched: 4 },
                errorRows: [
                  { rowNumber: 37, reason: 'attendee_email is not a valid address' },
                  { rowNumber: 112, reason: 'attendee_name is empty' },
                ],
                durationMs: 4280,
              },
            });
      }
      return realFetch(input, init);
    };
    return () => {
      window.fetch = realFetch;
    };
  }, [events, state]);

  useEffect(() => {
    const canonical = [
      'event_external_id,event_name,event_start,attendee_email,attendee_name,ticket_type',
      'midsummer-2026,Midsummer Celebration 2026,2026-06-20T17:00,erik@siamnordic.example,Erik Johansson,Member ticket',
      'midsummer-2026,Midsummer Celebration 2026,2026-06-20T17:00,karin@andamanmarine.example,Karin Lund,Partner ticket',
      'midsummer-2026,Midsummer Celebration 2026,2026-06-20T17:00,ploy.r@gmail.example,Ploy Rattanakul,',
    ].join('\n');
    const remap = [
      'Email Address,Full Name,Company Name,Ticket',
      'erik@siamnordic.example,Erik Johansson,Siam Nordic Trading,Member ticket',
      'karin@andamanmarine.example,Karin Lund,Andaman Marine Tech,Partner ticket',
    ].join('\n');
    const file =
      state === 'idle'
        ? null
        : state === 'error'
          ? new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'midsummer-celebration-2026.csv', { type: 'text/csv' })
          : new File([state === 'remap' ? remap : canonical], 'midsummer-celebration-2026.csv', { type: 'text/csv' });

    let tries = 0;
    let picked = false;
    let submitted = false;
    const id = window.setInterval(() => {
      const root = ref.current;
      if (!root || ++tries > 80) {
        window.clearInterval(id);
        return;
      }
      if (dialog === 'create') {
        if (document.querySelector('[role="dialog"]')) return window.clearInterval(id);
        [...root.querySelectorAll<HTMLButtonElement>('button')]
          .find((b) => b.textContent?.trim() === 'Create new event')
          ?.click();
        return;
      }
      if (file && !picked) {
        const input = root.querySelector<HTMLInputElement>('input[type="file"]');
        if (!input) return;
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        picked = true;
        return;
      }
      if ((state === 'mismatch' || state === 'result') && !submitted) {
        const confirm = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
          (b) => /^Confirm and import/.test(b.textContent?.trim() ?? '') && !b.disabled,
        );
        if (confirm) {
          confirm.click();
          submitted = true;
        }
        return;
      }
      window.clearInterval(id);
    }, 150);
    return () => window.clearInterval(id);
  }, [state, dialog]);
  return <div ref={ref}>{children}</div>;
}
