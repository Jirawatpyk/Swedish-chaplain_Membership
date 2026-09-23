/**
 * F119 T155 (U1, U7) — the two preview-frame reservations, in ONE place.
 *
 * A route's `loading.tsx` and its `page.tsx` have to agree on how much
 * vertical space the preview occupies, and nothing in the type system makes
 * them: `/portal/broadcasts/[id]` shipped a two-card skeleton against a
 * three-card page after T141 inserted a 560 px content card between them, and
 * the delivery card jumped ~640 px down on every settle (T155 finding U1).
 *
 * Framework-free constants, deliberately NOT in a `'use client'` module, so a
 * Server Component skeleton can import the same number the client pane
 * reserves with.
 */

/**
 * The compose pane's frame. Fixed, so the pane never grows or shrinks as the
 * deferred body settles — the document scrolls inside the frame instead.
 *
 * T155 finding U7: this is the height of the FRAME. Any padding around it
 * belongs to an outer box, never to the same border-box that carries the
 * reservation, or the ready state ends up taller than what was reserved.
 */
export const PREVIEW_PANE_FRAME_HEIGHT = 420;

/**
 * The member detail page's read-back frame (`/portal/broadcasts/[id]`), taller
 * than the compose pane because the page is a single column and the document
 * is the point of the screen rather than a companion to a form.
 */
export const DETAIL_PREVIEW_FRAME_HEIGHT = 560;
