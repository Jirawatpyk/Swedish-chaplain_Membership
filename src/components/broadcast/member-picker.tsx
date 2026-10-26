'use client';

/**
 * DV-4 — Admin member-picker.
 *
 * The combobox an admin uses to pick the member they are composing a
 * broadcast on behalf of (the proxy-submit flow). `inputRef` reaches the
 * combobox input so the compose form can re-focus it when the submit route
 * returns `broadcast_member_not_found`.
 *
 * Spec 122 US12d-3 (T1270) — on AURA's Combobox with `onSearch`, following
 * the US10a picker (`src/components/members/member-picker.tsx`): AURA owns the
 * combobox / listbox / option wiring the Popover + cmdk build hand-rolled, and
 * the field is 44 px on touch. The search stays this picker's own:
 *   - server search on `GET /api/admin/members/search?q=…&limit=10`,
 *     debounced 200 ms, only once something is typed (the list opens on a
 *     prompt to type rather than an unfiltered directory);
 *   - a cancellable fetch (`AbortController` + a cancelled flag, so a slow
 *     earlier answer never overwrites a later one) and a zod-validated body;
 *   - a failed search says so instead of "no members", which an admin would
 *     read as "the member does not exist";
 *   - each option is the company with its primary contact as the second line;
 *   - a clear button on the selection (Escape clears too) reports `null`.
 */

import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { Combobox } from '@jirawatpyk/aura-react';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

export interface MemberPickerOption {
  readonly memberId: string;
  readonly companyName: string;
  readonly primaryContactName: string | null;
  /** True when the member's primary contact has an email address on record. */
  readonly hasPrimaryContactEmail: boolean;
}

const SearchResponseSchema = z.object({
  items: z.array(
    z.object({
      memberId: z.string().uuid(),
      companyName: z.string(),
      primaryContactName: z.string().nullable(),
      hasPrimaryContactEmail: z.boolean(),
    }),
  ),
});

const DEBOUNCE_MS = 200;

export interface MemberPickerProps {
  readonly value: MemberPickerOption | null;
  readonly onSelect: (m: MemberPickerOption | null) => void;
  readonly label: string;
  readonly placeholder: string;
  readonly searchFailedText: string;
  readonly emptyText: string;
  readonly loadingText: string;
  readonly disabled?: boolean;
  /** The combobox input — focused by the form on a member error. */
  readonly inputRef?: React.Ref<HTMLInputElement>;
}

export function MemberPicker({
  value,
  onSelect,
  label,
  placeholder,
  searchFailedText,
  emptyText,
  loadingText,
  disabled = false,
  inputRef,
}: MemberPickerProps): React.ReactElement {
  const [rawQuery, setRawQuery] = useState('');
  const query = useDebouncedValue(rawQuery.trim(), DEBOUNCE_MS);
  const [results, setResults] = useState<readonly MemberPickerOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);

  // The state flips live inside the async run (not synchronously in the
  // effect body), as in the US10a picker.
  useEffect(() => {
    if (query === '') return;
    let cancelled = false;
    const controller = new AbortController();

    const run = async () => {
      setSearching(true);
      setSearchError(false);
      try {
        const res = await fetch(
          `/api/admin/members/search?q=${encodeURIComponent(query)}&limit=10`,
          { signal: controller.signal, headers: { Accept: 'application/json' } },
        );
        if (!res.ok) throw new Error(`member-search responded ${res.status}`);
        const parsed = SearchResponseSchema.safeParse(await res.json());
        if (!parsed.success) throw new Error('member-search response shape invalid');
        if (!cancelled) setResults(parsed.data.items);
      } catch (err: unknown) {
        // A superseded search aborts — expected, and not a failure.
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        console.error('member-search fetch failed', err);
        setResults([]);
        setSearchError(true);
      } finally {
        if (!cancelled) setSearching(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [query]);

  // An emptied field shows no stale results; the picked member stays listed
  // so the field keeps its name after the list changes.
  const visible = useMemo(() => (query === '' ? [] : results), [query, results]);
  const typed = rawQuery.trim();
  // "Searching…" from the first keystroke, not only once the debounce fires,
  // so the list never flashes "no members" while a search is still to come.
  const loading = typed !== '' && (searching || typed !== query);
  const options = useMemo(() => {
    const rows =
      value !== null && !visible.some((m) => m.memberId === value.memberId)
        ? [value, ...visible]
        : visible;
    return rows.map((m) => ({
      value: m.memberId,
      label: m.companyName,
      ...(m.primaryContactName ? { description: m.primaryContactName } : {}),
    }));
  }, [value, visible]);

  function note(): string {
    if (typed === '') return placeholder;
    return searchError ? searchFailedText : emptyText;
  }

  return (
    <div data-compose-feature="member-picker">
      <Combobox
        ref={inputRef}
        touchHeight
        label={label}
        placeholder={placeholder}
        options={options}
        value={value?.memberId ?? null}
        onSearch={setRawQuery}
        onChange={(next) => {
          if (next === null) {
            onSelect(null);
            return;
          }
          const hit = visible.find((m) => m.memberId === next) ?? value;
          if (hit !== null && hit.memberId === next) onSelect(hit);
        }}
        disabled={disabled}
        loading={loading}
        loadingText={loadingText}
        emptyText={note()}
      />
    </div>
  );
}
