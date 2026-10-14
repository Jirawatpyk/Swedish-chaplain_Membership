'use client';

/**
 * MemberPicker — reusable combobox for selecting an existing member.
 *
 * Powers the F1 spec:672-678 "link to member" field on the admin
 * invite dialog, and any future surface that needs to pick a member
 * by search.
 *
 * Props:
 *   - label / hint: the field's visible label and the line under it
 *   - value: MemberId | null — currently selected member id
 *   - onChange: (id: MemberId | null) => void — selection callback
 *   - disabled?: boolean — disables the field (used when role !== member)
 *
 * Behaviour:
 *   - Server search on `GET /api/members?limit=20&status=active&q=…`,
 *     debounced 200 ms; the first 20 load while the field is enabled.
 *   - A loading line while a search runs; a failed load says so instead of
 *     "No members found", which an admin would read as an empty directory.
 *   - Clear button on the selection (Escape clears too).
 *
 * Spec 122 US10a (T1005) — on AURA's Combobox with `onSearch` (as the
 * relink dialog), replacing the cmdk + popover build: AURA owns the
 * combobox / listbox / option wiring the old build hand-rolled (and once
 * got wrong — its `aria-controls` pointed at an id cmdk never rendered).
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Combobox } from '@jirawatpyk/aura-react';

export interface MemberPickerOption {
  readonly member_id: string;
  readonly company_name: string;
  readonly country: string;
  readonly status: string;
}

interface ApiRow {
  readonly member_id: string;
  readonly company_name: string;
  readonly country: string;
  readonly status: string;
}

interface ApiResponse {
  readonly items?: readonly ApiRow[];
}

export interface MemberPickerProps {
  /** Visible label; also the accessible name. */
  readonly label: string;
  /** The line under the field. */
  readonly hint?: string;
  readonly value: string | null;
  readonly onChange: (id: string | null) => void;
  readonly disabled?: boolean;
  readonly id?: string;
}

const DEBOUNCE_MS = 200;
const FETCH_LIMIT = 20;

type MemberStatus = 'active' | 'inactive' | 'archived';

function isKnownStatus(s: string): s is MemberStatus {
  return s === 'active' || s === 'inactive' || s === 'archived';
}

export function MemberPicker({ label, hint, value, onChange, disabled = false, id }: MemberPickerProps) {
  const t = useTranslations('admin.users.invite.linkMember');
  // Reuse the directory filter status keys so we have one source of truth
  // for status copy across EN/TH/SV (keys: active / inactive / archived).
  const tStatus = useTranslations('admin.members.directory.filters.status');

  const [rawInput, setRawInput] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<readonly MemberPickerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  // The chosen row, kept so its name still shows once a new search has
  // replaced the list.
  const [selected, setSelected] = useState<MemberPickerOption | null>(null);
  const effectiveSelected = value === null ? null : selected;

  // Debounce the search input.
  useEffect(() => {
    const handle = setTimeout(() => setQuery(rawInput.trim()), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [rawInput]);

  // Fetch while enabled, and whenever the debounced query changes. The
  // `setLoading(true)` lives inside the async IIFE (not synchronously in the
  // effect body) to avoid the set-state-in-effect lint.
  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    const controller = new AbortController();

    const run = async () => {
      setLoading(true);
      // Clear stale error before each new fetch — a "failed to load" line
      // lingering after the admin types a new query would mislead.
      setFetchError(false);
      const params = new URLSearchParams({ limit: String(FETCH_LIMIT) });
      // Only surface active members in the picker — archived/inactive
      // rows are rarely the right target for admin "link to member" flows.
      params.set('status', 'active');
      if (query.length > 0) params.set('q', query);
      try {
        const r = await fetch(`/api/members?${params.toString()}`, {
          method: 'GET',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!r.ok) {
          // Non-2xx (e.g. 401/500) — surface a fetch error state so the
          // list does not silently degrade to "No members found".
          if (!cancelled) {
            setItems([]);
            setFetchError(true);
          }
          console.error(`[member-picker] /api/members responded ${r.status}`);
          return;
        }
        const data = (await r.json()) as ApiResponse;
        if (cancelled) return;
        setItems(
          (data.items ?? []).map((row) => ({
            member_id: row.member_id,
            company_name: row.company_name,
            country: row.country,
            status: row.status,
          })),
        );
        setFetchError(false);
      } catch (e) {
        if (!cancelled) {
          setItems([]);
          // AbortError is expected on a superseded search — don't flag it.
          if (!(e instanceof DOMException && e.name === 'AbortError')) {
            setFetchError(true);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [disabled, query]);

  // Each option is the company, with its country and translated status as
  // the second line ("Active / ใช้งาน / Aktiv"; an unknown status shows raw
  // rather than throwing). The chosen row stays in the list so the field
  // keeps its name after the list changes.
  const options = useMemo(() => {
    const rows =
      effectiveSelected && !items.some((r) => r.member_id === effectiveSelected.member_id)
        ? [effectiveSelected, ...items]
        : items;
    return rows.map((opt) => ({
      value: opt.member_id,
      label: opt.company_name,
      description: `${opt.country} · ${isKnownStatus(opt.status) ? tStatus(opt.status) : opt.status}`,
    }));
  }, [effectiveSelected, items, tStatus]);

  return (
    <Combobox
      touchHeight
      {...(id !== undefined ? { id } : {})}
      label={label}
      {...(hint !== undefined ? { hint } : {})}
      placeholder={t('placeholder')}
      options={options}
      value={disabled ? null : value}
      onSearch={setRawInput}
      onChange={(next) => {
        if (next === null) {
          setSelected(null);
          onChange(null);
          return;
        }
        const hit = items.find((r) => r.member_id === next) ?? effectiveSelected;
        if (hit && hit.member_id === next) setSelected(hit);
        onChange(next);
      }}
      disabled={disabled}
      loading={loading}
      loadingText={t('loading')}
      emptyText={fetchError ? t('fetchError') : t('noMembersFound')}
    />
  );
}
