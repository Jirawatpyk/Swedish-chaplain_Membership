'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DropdownMenu, IconButton, type IconInput } from '@jirawatpyk/aura-react';

/**
 * Spec 122 US12c-1 (parity comment "จัดปุ่มใหม่", 20 Oct; board
 * `Admin-broadcast-review-mobile`) — below 640px the staff detail's pinned bar
 * keeps Reject and the next step as buttons and folds the secondary actions
 * into one ⋯ menu. An action inside `DetailActionBar` registers itself here;
 * its own button is then hidden below 640px and the menu item clicks it, so
 * the action keeps ONE dialog and one request path. A dialog opened from the
 * menu hands focus back to ⋯, since the item is gone once the menu closes.
 */

interface MenuEntry {
  readonly id: string;
  readonly order: number;
  readonly label: string;
  readonly icon: IconInput;
  readonly danger: boolean;
}

interface MoreMenuContext {
  readonly register: (entry: MenuEntry, open: () => void) => () => void;
  readonly select: (id: string) => void;
  readonly entries: ReadonlyArray<MenuEntry>;
  readonly menuTrigger: () => HTMLButtonElement | null;
  readonly setMenuWrap: (el: HTMLSpanElement | null) => void;
}

const Ctx = createContext<MoreMenuContext | null>(null);

export function DetailMoreMenuProvider({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  const [entries, setEntries] = useState<ReadonlyArray<MenuEntry>>([]);
  const [menuWrap, setMenuWrap] = useState<HTMLSpanElement | null>(null);
  // The openers stay out of render data: only the menu's labels are state.
  const openers = useRef(new Map<string, () => void>());
  const register = useCallback((entry: MenuEntry, open: () => void) => {
    openers.current.set(entry.id, open);
    setEntries((prev) => [...prev.filter((e) => e.id !== entry.id), entry].sort((a, b) => a.order - b.order));
    return () => {
      openers.current.delete(entry.id);
      setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    };
  }, []);
  const select = useCallback((id: string) => openers.current.get(id)?.(), []);
  const menuTrigger = useCallback(() => menuWrap?.querySelector('button') ?? null, [menuWrap]);
  const value = useMemo(() => ({ register, select, entries, menuTrigger, setMenuWrap }), [register, select, entries, menuTrigger]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The ⋯ trigger; shown below 640px only, and only when an action folded into it. */
export function DetailMoreMenu({ label }: { readonly label: string }): React.ReactElement | null {
  const ctx = useContext(Ctx);
  if (ctx === null || ctx.entries.length === 0) return null;
  const { entries, select, setMenuWrap } = ctx;
  return (
    <span ref={setMenuWrap} data-more-actions className="contents sm:hidden">
      <DropdownMenu
        label={label}
        items={entries.map((e) => ({
          label: e.label,
          icon: e.icon,
          ...(e.danger ? { tone: 'danger' as const } : {}),
          onSelect: () => select(e.id),
        }))}
        // Keep touchHeight: DropdownMenu adds a second wrapper, past AURA's
        // ActionBar IconButton rule (direct, or one wrapper deep).
        trigger={<IconButton icon="ellipsis" label={label} touchHeight data-testid="eblast-more-actions" />}
      />
    </span>
  );
}

/**
 * Registers an action in the bar's ⋯ menu while `folds` holds. Returns whether
 * it folded (the caller hides its own button below 640px) and the ref its
 * dialog returns focus to: ⋯ when the menu opened it, else its own button.
 */
export function useDetailMoreEntry(
  spec: { readonly id: string; readonly order: number; readonly label: string; readonly icon: IconInput; readonly danger?: boolean },
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  folds = true,
): {
  readonly folded: boolean;
  readonly returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  readonly markInline: () => void;
} {
  const ctx = useContext(Ctx);
  const viaMenu = useRef(false);
  const active = ctx !== null && folds;
  const register = ctx?.register;
  const menuTrigger = ctx?.menuTrigger;
  const { id, order, label, icon, danger = false } = spec;

  useEffect(() => {
    if (!active || register === undefined) return undefined;
    return register({ id, order, label, icon, danger }, () => {
      viaMenu.current = true;
      triggerRef.current?.click();
    });
  }, [active, register, id, order, label, icon, danger, triggerRef]);

  const returnFocusRef = useMemo(
    () =>
      ({
        get current() {
          return viaMenu.current && menuTrigger !== undefined ? (menuTrigger() ?? triggerRef.current) : triggerRef.current;
        },
      }) as React.RefObject<HTMLButtonElement | null>,
    [menuTrigger, triggerRef],
  );

  return {
    folded: active,
    returnFocusRef,
    // A real press on the inline button (pointer or key) means it, not the menu, opened the dialog.
    markInline: () => {
      viaMenu.current = false;
    },
  };
}
