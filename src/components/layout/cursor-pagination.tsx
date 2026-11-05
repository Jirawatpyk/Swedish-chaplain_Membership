'use client';

/**
 * Spec 122 — AURA `Pagination` in cursor mode (5.70) for keyset lists, so a
 * Server Component can render it: AURA's barrel is client-only, and every prop
 * here is serialisable (string hrefs, booleans, a status node). The callbacks
 * (`onFirst` / `onPrevious` / `onNext`) are left out on purpose — the links are
 * real `<a>`s through AuraBridge's `linkComponent`, so paging works without
 * JavaScript and the back button keeps working.
 */
import { Pagination, type CursorPaginationProps } from '@jirawatpyk/aura-react';

export type CursorPaginationLinksProps = Omit<
  CursorPaginationProps,
  'mode' | 'onFirst' | 'onPrevious' | 'onNext' | 'linkComponent'
>;

export function CursorPagination(props: CursorPaginationLinksProps): React.ReactElement {
  return <Pagination mode="cursor" {...props} />;
}
