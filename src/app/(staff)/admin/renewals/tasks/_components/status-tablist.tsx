/**
 * F8 Phase 8 R6 C-5 + R7 C3-2 close — ARIA APG composite-widget
 * tablist with roving tabIndex + Arrow-key navigation, **manual
 * activation**. WCAG 2.1 SC 4.1.2 compliance.
 *
 * Activation policy (R7 C3-2):
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
 * R7 SF-A close — `data-focused` attribute + ring-class on focused-
 * but-not-selected tabs provides a visual cue so sighted keyboard
 * users see they have a pending selection that needs activation.
 *
 * Extracted as own file in R7 IMP-D close so the keyboard contract is
 * unit-testable (`status-tablist.test.tsx`).
 */
'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

export const STATUS_TABS = ['open', 'done', 'skipped'] as const;
export type StatusTab = (typeof STATUS_TABS)[number];

export interface StatusTablistProps {
  readonly status: string;
  readonly t: (key: string) => string;
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
    const currentIdx =
      focusedIdx ?? STATUS_TABS.findIndex((s) => s === status);
    if (currentIdx === -1) return;
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
