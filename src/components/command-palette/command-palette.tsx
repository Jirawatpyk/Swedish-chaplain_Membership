/**
 * T154 — Command palette root component (US6).
 *
 * Global keyboard-accelerator (⌘K / Ctrl+K) that opens a search palette
 * over the admin shell. Lazy-loads `/api/plans/search` on the first
 * keystroke after the palette opens — never on mount — so the palette
 * adds zero network cost to initial page load.
 *
 * Behaviour contract (critique P8 + US6 AS1-4):
 *   - ⌘K / Ctrl+K toggles the palette from any admin page (AURA's hotkey),
 *     and the top bar's search button opens it (`OPEN_COMMAND_PALETTE_EVENT`).
 *   - Esc closes the palette; focus returns to the previously-active element
 *     (AURA's modal restores it).
 *   - Arrow-key + Enter navigation is AURA `Command`'s (spec 122 US1).
 *   - Results are grouped (see `groups.tsx`); a group with nothing in it is
 *     not shown. The server searched them, so AURA's own filter is off.
 *   - Results render exactly as the server sent them. The client-side role
 *     mirror was REMOVED in T064: per-entry permission filtering happens in
 *     `/api/plans/search`, and no client copy can reproduce it (`canPerform`
 *     reads `env`). What the mirror actually did on the ON leg was blank the
 *     palette for `marketing`.
 *   - React 19 `useDeferredValue` keeps typing input responsive while
 *     the filter-then-render runs concurrently. No explicit setTimeout
 *     debounce — scheduler + deferred value handles it.
 *
 * Accessibility (AURA `Command`):
 *   - A `role="dialog"` named "Command palette", a combobox input focused
 *     on open, a listbox of options; the result count is announced when
 *     results arrive, and "Searching…" shows while they load.
 *   - Reduced motion is honoured by AURA's CSS.
 */
'use client';

import { useCallback, useDeferredValue, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Command } from '@jirawatpyk/aura-react';

import { paletteItems } from './groups';
import { OPEN_COMMAND_PALETTE_EVENT } from './open-event';
import type { PaletteSearchResponse } from './registry';

const EMPTY_RESULTS: PaletteSearchResponse['results'] = {
  plans: [],
  members: [],
  refundableInvoices: [],
  actions: [],
  navigate: [],
};

export function CommandPalette() {
  const t = useTranslations('palette');
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PaletteSearchResponse['results']>(EMPTY_RESULTS);
  const [answeredQuery, setAnsweredQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  // The top bar's search button (spec 122 US1); ⌘K itself is AURA's hotkey.
  useEffect(() => {
    const openPalette = () => setOpen(true);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, openPalette);
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, openPalette);
  }, []);

  // Lazy fetch — runs only after the palette is open AND the user has
  // typed something. Cold-open cost is therefore just "render dialog",
  // not "render dialog + fetch". When `deferredQuery` is empty the effect
  // short-circuits; the render fallback swaps in `EMPTY_RESULTS` so nothing
  // stale is shown.
  useEffect(() => {
    if (!open) return;
    const q = deferredQuery.trim();
    if (q.length === 0) return;

    let cancelled = false;

    fetch(`/api/plans/search?q=${encodeURIComponent(q)}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`search failed: ${res.status}`);
        const body = (await res.json()) as PaletteSearchResponse;
        if (cancelled) return;
        setResults(body.results);
        setAnsweredQuery(q);
      })
      .catch(() => {
        if (cancelled) return;
        setResults(EMPTY_RESULTS);
        setAnsweredQuery(q);
      });

    return () => {
      cancelled = true;
    };
  }, [deferredQuery, open]);

  // Reset query + results on close so the next open starts fresh.
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery('');
      setResults(EMPTY_RESULTS);
      setAnsweredQuery('');
    }
  }, []);

  const navigate = useCallback(
    (url: string) => {
      handleOpenChange(false);
      router.push(url);
    },
    [handleOpenChange, router],
  );

  // Results render exactly as the server sent them. The client-side role
  // mirror was REMOVED in T064: per-entry permission filtering happens in
  // `/api/plans/search`, and no client copy can reproduce it (`canPerform`
  // reads `env`). A wrong mirror is worse than no mirror: it hides entries
  // the server deliberately sent, and the failure is silent.
  const typed = query.trim();
  const items = typed.length > 0 ? paletteItems(results, t, locale, navigate) : [];

  return (
    <Command
      open={open}
      onOpenChange={handleOpenChange}
      label={t('title')}
      placeholder={t('placeholder')}
      items={items}
      filter={false}
      query={query}
      onQueryChange={setQuery}
      loading={typed.length > 0 && answeredQuery !== typed}
      // Before anything is typed, say what the palette searches.
      empty={typed.length > 0 ? t('empty') : t('description')}
    />
  );
}
