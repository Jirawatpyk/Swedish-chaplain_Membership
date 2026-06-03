/**
 * useInlineEditField — shared inline-edit cell controller (P2.1).
 *
 * Extracted from the near-identical `InlineCountryCell` + `InlineNotesCell`
 * logic in members-table.tsx. Centralises the cross-cutting concerns that
 * are easy to get subtly wrong and were duplicated per cell:
 *
 *   - `editing` (null = display mode, string = draft) / `saving` / a
 *     "Saved" SR flash that auto-clears after 2s.
 *   - `savingRef`  — SYNCHRONOUS double-fire guard. `saving` state is
 *     async, so pressing Enter then having `blur` fire immediately would
 *     read `saving === false` in both handlers and submit twice. A ref is
 *     synchronous, so the second concurrent `handleSave` short-circuits
 *     before the DB roundtrip. (Round-4 R4-I1.)
 *   - `cancellingRef` — SYNCHRONOUS Escape+blur guard. On Escape the input
 *     unmounts and some browsers fire a `blur` before unmount, which would
 *     trigger `handleSave` with the stale draft. The flag lets the Escape
 *     branch short-circuit the queued blur. (Staff-review SW-6.)
 *   - focus (+ optional select-all) on entering edit mode, via an effect
 *     keyed on `editing` (more reliable than rAF under React 19 concurrent
 *     rendering — round-3 N-I6).
 *
 * The value-specific bits (validation, the `onSave` call, success/error
 * toasts) live in the caller's `commit` callback, which returns what the
 * hook should do next: keep editing open ('kept-open', e.g. save failed —
 * preserve the draft), close with a "Saved" flash ('saved'), or close
 * quietly ('closed', e.g. no-op / invalid).
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

export type InlineSaveOutcome = 'saved' | 'closed' | 'kept-open';

export interface UseInlineEditFieldOptions<T> {
  /** Persisted value (the prop) — snapshotted into the draft on startEdit. */
  readonly current: T;
  /** Map the persisted value to the initial draft string on startEdit. */
  readonly toDraft: (current: T) => string;
  /**
   * Validate + persist the draft. The caller owns validation, the
   * `onSave` call, and all toasts; it returns what the hook should do:
   *   'saved'     → flash "Saved" + leave edit mode
   *   'closed'    → leave edit mode, no flash (no-op / invalid input)
   *   'kept-open' → stay in edit mode (save failed — preserve the draft)
   */
  readonly commit: (
    draft: string,
    current: T,
  ) => Promise<InlineSaveOutcome> | InlineSaveOutcome;
  /**
   * Whether an Enter keypress submits. Defaults to "any Enter". Notes
   * passes `(e) => !e.shiftKey` so Shift+Enter inserts a newline instead.
   */
  readonly submitOnEnter?: (e: KeyboardEvent<HTMLElement>) => boolean;
  /** Select-all on focus (country code) vs caret-only (notes textarea). */
  readonly selectOnFocus?: boolean;
}

export interface UseInlineEditField<E extends HTMLElement> {
  /** Current draft, or null in display mode. */
  readonly editing: string | null;
  readonly isEditing: boolean;
  readonly saving: boolean;
  readonly savedFlash: boolean;
  /** Attach to the <input>/<textarea> — focused on entering edit mode. */
  readonly fieldRef: React.RefObject<E | null>;
  /** Enter edit mode (snapshots `current` into the draft). */
  readonly startEdit: () => void;
  /** Update the draft while editing. */
  readonly setDraft: (value: string) => void;
  /** Run the guarded save lifecycle (wire to onBlur). */
  readonly handleSave: () => Promise<void>;
  /** Enter-submits / Escape-cancels (wire to onKeyDown). */
  readonly handleKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Enter/Space activation for a control whose only mouse affordance is
 * double-click (e.g. an inline-edit `<button>` in a dense grid). A native
 * button with only `onDoubleClick` is keyboard-dead — Enter/Space fire
 * `click`, not `dblclick` (WCAG 2.1 SC 2.1.1). Returns the `onKeyDown`
 * handler so both inline cells share one definition (code-review #14). This
 * is DISPLAY-mode activation only — distinct from the hook's edit-mode
 * `handleKeyDown` (Enter-submit / Escape-cancel).
 */
export function activateOnEnterSpace(
  activate: () => void,
): (e: KeyboardEvent<HTMLElement>) => void {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  };
}

export function useInlineEditField<
  T,
  E extends HTMLInputElement | HTMLTextAreaElement = HTMLInputElement,
>(opts: UseInlineEditFieldOptions<T>): UseInlineEditField<E> {
  const { current, toDraft, commit, submitOnEnter, selectOnFocus } = opts;

  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const fieldRef = useRef<E>(null);
  const savingRef = useRef(false);
  const cancellingRef = useRef(false);

  useEffect(() => {
    if (!savedFlash) return;
    const id = setTimeout(() => setSavedFlash(false), 2000);
    return () => clearTimeout(id);
  }, [savedFlash]);

  useEffect(() => {
    if (editing !== null) {
      fieldRef.current?.focus();
      if (selectOnFocus) fieldRef.current?.select();
    }
  }, [editing, selectOnFocus]);

  const startEdit = useCallback(() => {
    setEditing(toDraft(current));
  }, [toDraft, current]);

  const setDraft = useCallback((value: string) => {
    setEditing(value);
  }, []);

  const handleSave = useCallback(async () => {
    if (cancellingRef.current || editing === null || savingRef.current) return;
    savingRef.current = true;
    try {
      setSaving(true);
      const outcome = await commit(editing, current);
      if (outcome === 'saved') {
        setSavedFlash(true);
        setEditing(null);
      } else if (outcome === 'closed') {
        setEditing(null);
      }
      // 'kept-open' → leave the draft open so the admin can retry.
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  }, [editing, current, commit]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter') {
        const submits = submitOnEnter ? submitOnEnter(e) : true;
        if (!submits) return; // e.g. Shift+Enter in a textarea → newline
        e.preventDefault();
        void handleSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // Set the sync flag BEFORE clearing state so any queued
        // blur-triggered handleSave short-circuits; reset next tick once
        // the blur has flushed.
        cancellingRef.current = true;
        setEditing(null);
        queueMicrotask(() => {
          cancellingRef.current = false;
        });
      }
    },
    [submitOnEnter, handleSave],
  );

  return {
    editing,
    isEditing: editing !== null,
    saving,
    savedFlash,
    fieldRef,
    startEdit,
    setDraft,
    handleSave,
    handleKeyDown,
  };
}
