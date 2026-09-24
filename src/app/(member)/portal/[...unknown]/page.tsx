import { notFound } from 'next/navigation';

/**
 * Catch-all for unmatched `/portal/*` URLs (portal error states #3).
 *
 * A segment `not-found.tsx` only catches `notFound()` thrown inside its
 * segment; a URL that matches NO route never reaches it and renders the
 * framework's root 404 instead. Matching the rest of the path here and
 * answering `notFound()` routes those URLs to `portal/not-found.tsx`, inside
 * the member layout (so the session guard still runs first). Every real route
 * outranks a catch-all, so nothing existing is shadowed.
 */
export default function UnknownPortalRoute(): never {
  notFound();
}
