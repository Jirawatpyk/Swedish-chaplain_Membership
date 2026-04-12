/**
 * T154 — Command palette root component (US6).
 *
 * Global keyboard-accelerator (⌘K / Ctrl+K) that opens a search palette
 * over the admin shell. Lazy-loads `/api/plans/search` on the first
 * keystroke after the palette opens — never on mount — so the palette
 * adds zero network cost to initial page load.
 *
 * Behaviour contract (critique P8 + US6 AS1-4):
 *   - ⌘K / Ctrl+K toggles the palette from any admin page.
 *   - Esc closes the palette; focus returns to the previously-active element.
 *   - Arrow-key + Enter navigation is provided by `cmdk` under the hood.
 *   - Results are grouped into Plans / Actions / Navigate (three
 *     `<CommandGroup>`s, hidden when empty).
 *   - Defence-in-depth: a client-side role filter drops any admin-only
 *     entry that somehow slipped through the server filter (see
 *     `registry.ts`).
 *   - React 19 `useDeferredValue` keeps typing input responsive while
 *     the filter-then-render runs concurrently. No explicit setTimeout
 *     debounce — scheduler + deferred value handles it.
 *
 * Accessibility:
 *   - Reduced-motion users bypass the scale animation (CSS
 *     `motion-reduce:` utility classes in `dialog.tsx` already honour
 *     `prefers-reduced-motion`).
 *   - The search input is focused automatically when the palette opens.
 *   - The CommandDialog renders `role="dialog"` with an sr-only title
 *     + description for screen readers.
 */
'use client';

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useTranslations } from 'next-intl';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandList,
} from '@/components/ui/command';
// Type-only import of Role from the deep domain path — importing from
// the auth barrel would chain-pull argon2 into the client bundle.
// eslint-disable-next-line no-restricted-imports
import type { Role } from '@/modules/auth/domain/role';
import { PaletteGroups } from './groups';
import type { PaletteSearchResponse } from './registry';

type CommandPaletteProps = {
  readonly currentUserRole: Role;
};

const EMPTY_RESULTS: PaletteSearchResponse['results'] = {
  plans: [],
  actions: [],
  navigate: [],
};

export function CommandPalette({ currentUserRole }: CommandPaletteProps) {
  const t = useTranslations('palette');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PaletteSearchResponse['results']>(
    EMPTY_RESULTS,
  );
  const [isPending, startTransition] = useTransition();
  const deferredQuery = useDeferredValue(query);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Global ⌘K / Ctrl+K listener. Registered once on mount; toggles
  // `open` so a second ⌘K while the palette is open closes it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => {
          if (!prev) {
            // Remember the previously-active element so we can restore
            // focus when the palette closes. Bails out if there is no
            // focused element (e.g. document.body).
            const active = document.activeElement;
            if (active instanceof HTMLElement && active !== document.body) {
              previouslyFocused.current = active;
            } else {
              previouslyFocused.current = null;
            }
          }
          return !prev;
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Restore focus when the palette closes. Running inside an effect
  // ensures the dialog has actually unmounted its own focus trap first.
  useEffect(() => {
    if (!open && previouslyFocused.current) {
      const target = previouslyFocused.current;
      previouslyFocused.current = null;
      // Defer one frame so Radix/Base UI focus trap releases first.
      requestAnimationFrame(() => {
        target.focus();
      });
    }
  }, [open]);

  // Lazy fetch — runs only after the palette is open AND the user has
  // typed something. Cold-open cost is therefore just "render dialog",
  // not "render dialog + fetch". Warm opens with the same query reuse
  // the previously-fetched results in state. When `deferredQuery` is
  // empty the effect short-circuits; the render fallback swaps in
  // `EMPTY_RESULTS` so nothing stale is shown.
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
        // Wrap in a transition so the render of the results list is
        // marked as non-urgent, keeping typing input responsive.
        startTransition(() => {
          setResults(body.results);
        });
      })
      .catch(() => {
        if (cancelled) return;
        startTransition(() => {
          setResults(EMPTY_RESULTS);
        });
      });

    return () => {
      cancelled = true;
    };
  }, [deferredQuery, open]);

  // Reset query + results on close so the next open starts fresh.
  // Handled via `onOpenChange` rather than a `useEffect` to avoid a
  // set-state-inside-effect cascade render.
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery('');
      setResults(EMPTY_RESULTS);
    }
  }, []);

  const handleAfterNavigate = useCallback(() => {
    handleOpenChange(false);
  }, [handleOpenChange]);

  // Defence-in-depth: filter actions by role on the client too. The
  // server is authoritative, but this costs nothing and prevents a
  // server-side bug from flashing an admin-only item to a manager.
  // Also swap in EMPTY_RESULTS when there is no query so the list
  // starts blank instead of showing stale prior-query hits.
  const hasQuery = deferredQuery.trim().length > 0;
  const sourceResults = hasQuery ? results : EMPTY_RESULTS;
  const filteredResults = currentUserRole === 'admin'
    ? sourceResults
    : {
        plans: sourceResults.plans,
        actions: currentUserRole === 'manager'
          ? sourceResults.actions.filter((a) => !isAdminOnlyAction(a.id))
          : [],
        navigate: currentUserRole === 'member' ? [] : sourceResults.navigate,
      };

  const hasAnyResult =
    filteredResults.plans.length +
      filteredResults.actions.length +
      filteredResults.navigate.length >
    0;

  return (
    <CommandDialog
      title={t('title')}
      description={t('description')}
      open={open}
      onOpenChange={handleOpenChange}
    >
      {/*
        The project's `CommandDialog` (src/components/ui/command.tsx)
        does not wrap children in a `<Command>` root, so we add it
        explicitly here. Without the Command context, cmdk's Input /
        List / Item subscribers throw `Cannot read properties of
        undefined (reading 'subscribe')` on mount.
      */}
      <Command>
        <CommandInput
          placeholder={t('placeholder')}
          value={query}
          onValueChange={setQuery}
          aria-busy={isPending}
        />
        <CommandList>
          {!hasAnyResult && query.trim().length > 0 && (
            <CommandEmpty>{t('empty')}</CommandEmpty>
          )}
          <PaletteGroups
            results={filteredResults}
            onAfterNavigate={handleAfterNavigate}
          />
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

// Mirror of `ACTION_REGISTRY` entries that carry `requires: 'admin'`
// in `search-plans.ts`. Kept as a string-set check here rather than an
// import to keep this file free of server-side module imports.
const ADMIN_ONLY_ACTION_IDS = new Set(['plan.new', 'plan.clone', 'fee.edit']);

function isAdminOnlyAction(id: string): boolean {
  return ADMIN_ONLY_ACTION_IDS.has(id);
}
