/**
 * 058 G1 — /portal/benefits/e-blasts is now a tab inside /portal/benefits
 * (spec §4.4). The ROUTE IS PRESERVED for EXTERNAL / email deep-links (older
 * notification emails and bookmarks point here) — a 404 would break those, so
 * we permanently redirect to the Broadcasts tab. Internal navigation now links
 * straight at `?tab=broadcasts` to avoid a chain redirect.
 *
 * The `_helpers/quota-banner.ts` module stays — BroadcastsPanel + the broadcast
 * detail page still import it.
 */
import { permanentRedirect } from 'next/navigation';

export default async function EblastsRedirectPage(): Promise<never> {
  permanentRedirect('/portal/benefits?tab=broadcasts');
}
