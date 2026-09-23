'use client';

/**
 * F119 T145 (US6-AS5, FR-039) — the one draft-save round trip both compose
 * forms make.
 *
 * `compose-form.tsx` (member) and `proxy-compose-form.tsx` (staff acting for a
 * member) save to two different endpoints — `/api/broadcasts/draft` and
 * `/api/admin/broadcasts/draft` — that answer in one envelope
 * (`src/lib/broadcasts-draft-response.ts`). Everything between the two is the
 * same: POST creates, PUT updates and carries the existing `draftId`, a refusal
 * arrives as `{ error: { code } }`, and the created id comes back as
 * `broadcastId` and must be captured or the inline-image uploader stays hidden
 * for good (the 2026-05-21 member-compose bug).
 *
 * Only that round trip lives here. Each form keeps its own busy state, its own
 * toasts and its own i18n namespace — they are genuinely different copy, and a
 * hook that owned them would take more parameters than it saved lines.
 */

export type ComposeDraftSaveResult =
  | { readonly ok: true; readonly broadcastId: string | null }
  | { readonly ok: false; readonly code: string };

export async function saveComposeDraft(input: {
  readonly endpoint: string;
  /** The draft being updated, or `null` to create one. */
  readonly draftId: string | null;
  /** Subject, body, segment and schedule — whatever the endpoint's schema takes. */
  readonly payload: Record<string, unknown>;
}): Promise<ComposeDraftSaveResult> {
  const body: Record<string, unknown> = { ...input.payload };
  if (input.draftId !== null) body['draftId'] = input.draftId;

  try {
    const res = await fetch(input.endpoint, {
      method: input.draftId !== null ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const refusal = (await res.json().catch(() => null)) as {
        error?: { code?: unknown };
      } | null;
      const code = refusal?.error?.code;
      return { ok: false, code: typeof code === 'string' ? code : 'internal_error' };
    }

    const saved = (await res.json().catch(() => null)) as {
      broadcastId?: unknown;
    } | null;
    return {
      ok: true,
      broadcastId:
        typeof saved?.broadcastId === 'string' ? saved.broadcastId : null,
    };
  } catch (e) {
    // Network / CSP / offline. Logged so the three are distinguishable in the
    // browser console; the caller's toast copy stays generic.

    console.error(
      { err: e instanceof Error ? e.message : String(e), endpoint: input.endpoint },
      'broadcasts.save_draft.fetch_failed',
    );
    return { ok: false, code: 'internal_error' };
  }
}
