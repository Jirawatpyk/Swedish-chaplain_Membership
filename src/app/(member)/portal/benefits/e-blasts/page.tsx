/**
 * 058 G1 — /portal/benefits/e-blasts is now a tab inside /portal/benefits
 * (spec §4.4). The ROUTE IS PRESERVED (the broadcast-detail back-link and the
 * FR-009 cap=0 compose redirect both target it) — a 404 here would break those
 * deep-links, so we permanently redirect to the Broadcasts tab.
 *
 * The `_helpers/quota-banner.ts` module stays — BroadcastsPanel + the broadcast
 * detail page still import it.
 */
import { redirect } from 'next/navigation';

export default async function EblastsRedirectPage(): Promise<never> {
  redirect('/portal/benefits?tab=broadcasts');
}
