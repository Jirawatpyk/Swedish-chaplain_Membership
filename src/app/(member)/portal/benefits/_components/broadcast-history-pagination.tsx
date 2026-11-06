'use client';

/**
 * Spec 122 — the E-Blast history pager on AURA `Pagination` (pages mode).
 * A client wrapper only because `getHref` is a function, which a Server
 * Component cannot pass: the panel gives the page and the count, this builds
 * the same `?tab=broadcasts&page=N` links (so `?tab=` and `?page=` coexist on
 * the tabbed Benefits page, 058 G1). Real links through AuraBridge's
 * `linkComponent`; AURA disables Previous / Next at the edges.
 */
import { Pagination } from '@jirawatpyk/aura-react';

const historyPageHref = (page: number): string => `/portal/benefits?tab=broadcasts&page=${page}`;

export function BroadcastHistoryPagination({
  page,
  pageCount,
  label,
}: {
  readonly page: number;
  readonly pageCount: number;
  /** The nav's accessible name. */
  readonly label: string;
}): React.ReactElement {
  return <Pagination pageCount={pageCount} page={page} getHref={historyPageHref} label={label} />;
}
