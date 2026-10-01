'use client';

/**
 * Spec 122 stand-in for AURA handoff #122 (R24, `renewal-a11y` "44px
 * targets"): an AURA `ActionBar` whose "Clear" is a 44px touch target.
 *
 * AURA 5.22 draws the Clear for `onClearSelection` itself, as a 32px ghost
 * button with no way to give it `touchHeight`, so a bulk bar whose own
 * buttons are 44px still carries one 32px control. Until AURA ships it, this
 * wrapper renders the Clear itself:
 *   - first among the actions, where AURA places it, and only while
 *     something is selected (an idle bar has no actions);
 *   - with AURA's focus return: after a Clear empties the selection the bar
 *     goes idle and its buttons leave, so focus goes back to where it was
 *     before it entered the bar (when it has nowhere else to be).
 * The wrapper is `display: contents`, so the bar stays a direct, sticky
 * child of its parent. Drop it, and pass `onClearSelection` straight to
 * `ActionBar`, when AURA ships #122.
 */
import { forwardRef, useRef, type FocusEvent } from 'react';
import { ActionBar, Button, type ActionBarProps } from '@jirawatpyk/aura-react';

export interface TouchClearActionBarProps extends ActionBarProps {
  /** The Clear button's text (AURA's own Clear read it from `strings.clear`). */
  readonly clearLabel: string;
}

export const TouchClearActionBar = forwardRef<HTMLDivElement, TouchClearActionBarProps>(
  function TouchClearActionBar({ clearLabel, onClearSelection, selected, children, ...rest }, ref) {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const cameFrom = useRef<HTMLElement | null>(null);

    function onFocus(e: FocusEvent<HTMLDivElement>) {
      const from = e.relatedTarget;
      if (from instanceof HTMLElement && wrapperRef.current && !wrapperRef.current.contains(from)) {
        cameFrom.current = from;
      }
    }

    function clear() {
      onClearSelection?.();
      setTimeout(() => {
        const back = cameFrom.current;
        const active = document.activeElement;
        if ((!active || active === document.body || !active.isConnected) && back?.isConnected) back.focus();
      }, 0);
    }

    return (
      <div ref={wrapperRef} className="contents" onFocus={onFocus}>
        <ActionBar ref={ref} {...rest} selected={selected}>
          {selected && onClearSelection ? (
            <Button variant="ghost" size="sm" touchHeight onClick={clear}>
              {clearLabel}
            </Button>
          ) : null}
          {children}
        </ActionBar>
      </div>
    );
  },
);
