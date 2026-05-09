/**
 * F8 Phase 8 R6 C-5 + R8 C3-2 close — ARIA APG composite-widget
 * tablist with roving tabIndex + Arrow-key navigation, **manual
 * activation**. WCAG 2.1 SC 4.1.2 compliance.
 *
 * Activation policy (R8 C3-2):
 *   - Each status tab loads server-rendered data (Neon fetch). Per
 *     ARIA APG: "If the tab panel contains content that is not
 *     present until the tab is selected ... it is recommended to use
 *     manual activation." Arrow keys move FOCUS only — they do NOT
 *     trigger `onSelect`. Activation requires Space / Enter (or
 *     click).
 *
 * Keyboard contract:
 *   - Tab: Tab IN focuses the selected tab (tabIndex=0); Tab OUT
 *     exits the group (other tabs have tabIndex=-1).
 *   - ArrowLeft / ArrowUp: focus previous tab (wrap-around).
 *   - ArrowRight / ArrowDown: focus next tab (wrap-around).
 *   - Home / End: focus first / last tab.
 *   - Enter / Space: activate the focused tab (default Button click).
 *
 * R8 SF-A close — `data-focused` attribute + ring-class on focused-
 * but-not-selected tabs provides a visual cue so sighted keyboard
 * users see they have a pending selection that needs activation.
 *
 * Extracted as own file in R8 IMP-D close so the keyboard contract is
 * unit-testable (`status-tablist.test.tsx`).
 */
'use client';

import { useRef, useState } from 'react';
import type { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

export const STATUS_TABS = ['open', 'done', 'skipped'] as const;
export type StatusTab = (typeof STATUS_TABS)[number];

/**
 * R8 R4-IMP-2 close — `t` is the namespaced next-intl translator
 * function (mirrors precedent at pipeline-table.tsx, schedule-editor,
 * breadcrumb-nav). Restores ICU key safety inside StatusTablist so a
 * typo in `t('status_tabs_aria')` or a key from a sibling namespace
 * fails at compile time.
 *
 * R8 R4-IMP-3 close — `status` narrowed to `StatusTab` (from `string`).
 * The `currentIdx === -1` defensive branch is removed because the
 * type system now prevents an unknown status from reaching the
 * tablist. Callers narrow upstream via the URL whitelist guard.
 */
export interface StatusTablistProps {
  readonly status: StatusTab;
  readonly t: ReturnType<typeof useTranslations<'admin.renewals.tasks'>>;
  readonly onSelect: (next: StatusTab) => void;
}

export function StatusTablist({
  status,
  t,
  onSelect,
}: StatusTablistProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);

  function focusByIndex(idx: number): void {
    const wrapped = (idx + STATUS_TABS.length) % STATUS_TABS.length;
    refs.current[wrapped]?.focus();
    setFocusedIdx(wrapped);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    // R8 R4-IMP-3 close — `status: StatusTab` is type-narrowed so
    // findIndex always returns a valid index; no defensive `=== -1`
    // bail-out needed.
    const currentIdx =
      focusedIdx ?? STATUS_TABS.findIndex((s) => s === status);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusByIndex(currentIdx - 1);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusByIndex(currentIdx + 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusByIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusByIndex(STATUS_TABS.length - 1);
    }
    // Enter / Space activation falls through to the Button's default
    // click handler (no preventDefault) — onClick fires → onSelect.
  }

  return (
    <div
      className="flex gap-1"
      role="tablist"
      aria-label={t('status_tabs_aria')}
      onKeyDown={handleKeyDown}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFocusedIdx(null);
        }
      }}
    >
      {STATUS_TABS.map((s, idx) => {
        const selected = status === s;
        const focused = focusedIdx === idx && !selected;
        return (
          <Button
            key={s}
            id={`task-status-tab-${s}`}
            ref={(el) => {
              refs.current[idx] = el;
            }}
            size="sm"
            variant={selected ? 'default' : 'outline'}
            role="tab"
            aria-selected={selected}
            aria-controls="escalation-tasks-tabpanel"
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(s)}
            onFocus={() => setFocusedIdx(idx)}
            data-focused={focused ? 'true' : undefined}
            className={
              focused ? 'ring-2 ring-primary/40 ring-offset-2' : undefined
            }
          >
            {t(`status_tab.${s}`)}
          </Button>
        );
      })}
    </div>
  );
}
