/**
 * `/portal/account/data-export` — PRESERVED route (spec §4.5 + §97).
 *
 * The member GDPR data-export panel now lives in the Account hub's
 * Data & privacy section (/portal/account#data-privacy). This legacy route
 * redirects there so any existing deep-link keeps resolving (no 404).
 *
 * F9 gate: the hub's Data & privacy section only renders when
 * `env.features.f9Dashboard && memberId` (see ../page.tsx). When F9 is dark,
 * an unconditional redirect would drop the member onto the hub with no
 * `#data-privacy` anchor and no error (silent no-op).
 *
 * The pre-D2 standalone /portal/account/data-export page gated on F9
 * (notFound() when off). The hub's Data & privacy section is also F9-gated, so
 * when F9 is off there is no `#data-privacy` anchor to land on — restore the
 * 404 here. NOTE: use `redirect()` (307) not `permanentRedirect()` (308)
 * because this route's target existence is F9-flag-dependent; a cached 308
 * would bypass this notFound() if the flag flips off (break-glass), landing
 * the member on a hub with no #data-privacy section and skipping the server
 * entirely (R2-5). 307 is NOT cached, so the notFound() guard is re-evaluated
 * on every visit. (Contrast the UNCONDITIONAL legacy redirects in
 * ../../preferences/renewals + ../../benefits/e-blasts, which correctly use
 * cacheable 308 permanentRedirect.)
 */
import { notFound, redirect } from 'next/navigation';
import { env } from '@/lib/env';

export default async function PortalDataExportPage(): Promise<never> {
  if (!env.features.f9Dashboard) notFound();
  redirect('/portal/account#data-privacy');
}
