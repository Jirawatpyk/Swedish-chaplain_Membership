'use client';

/**
 * F119 T143 (US6-AS9, FR-045, SC-012 — the navigation-and-draft-saving arm).
 *
 * The unsaved-changes guard both compose forms use. It compares the live
 * subject/body against the LAST SAVED snapshot, not against the immutable
 * props the page mounted with — the member compose form used to do the latter
 * (`compose-form.tsx:203-217`), so a member who saved a draft and changed
 * nothing since was still warned on the way out, which teaches people to
 * dismiss the warning that matters.
 *
 * The staff compose-on-behalf form uses the SAME rule since T145 shipped
 * `POST | PUT /api/admin/broadcasts/draft`: a successful staff draft save
 * calls `markSaved`, so saving and leaving is silent while typing and leaving
 * still warns — the FR-039 parity item, now closed on both sides. (This
 * paragraph used to say "no staff draft endpoint exists"; it does.)
 */
import { useCallback, useState } from 'react';
import { useBeforeUnloadGuard } from '@/hooks/use-beforeunload-guard';

export interface ComposeSnapshot {
  readonly subject: string;
  readonly bodyHtml: string;
}

export interface ComposeDirtyGuard {
  /** True when the live content differs from the last saved snapshot. */
  readonly dirty: boolean;
  /** When the last successful save landed, for the "Saved at HH:MM" line. */
  readonly savedAt: Date | null;
  /** Call on a SUCCESSFUL save with the content that was sent. */
  readonly markSaved: (snapshot: ComposeSnapshot, at?: Date) => void;
}

export function useComposeDirtyGuard(
  current: ComposeSnapshot,
  options: {
    readonly initial: ComposeSnapshot;
    /**
     * Suppress the prompt while a submit is in flight — the post-submit
     * `router.push` would otherwise trip the browser's own dialog on the way
     * to the confirmation page.
     */
    readonly suspended?: boolean;
  },
): ComposeDirtyGuard {
  const [saved, setSaved] = useState<{
    readonly snapshot: ComposeSnapshot;
    readonly at: Date | null;
  }>({ snapshot: options.initial, at: null });

  const dirty =
    current.subject !== saved.snapshot.subject ||
    current.bodyHtml !== saved.snapshot.bodyHtml;
  const armed = dirty && options.suspended !== true;

  // The listener itself is shared with Brand settings (T155 U18); what is NOT
  // shared is the comparison above, which is this surface's own rule.
  useBeforeUnloadGuard(armed);

  const markSaved = useCallback(
    (snapshot: ComposeSnapshot, at: Date = new Date()): void => {
      setSaved({ snapshot, at });
    },
    [],
  );

  return { dirty, savedAt: saved.at, markSaved };
}
