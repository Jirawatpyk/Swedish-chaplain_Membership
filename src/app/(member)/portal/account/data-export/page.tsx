/**
 * `/portal/account/data-export` — PRESERVED route (spec §4.5 + §97).
 *
 * The member GDPR data-export panel now lives in the Account hub's
 * Data & privacy section (/portal/account#data-privacy). This legacy route
 * permanently redirects there (308, browser-cacheable) so any existing
 * deep-link keeps resolving (no 404).
 *
 * F9 gate: the hub's Data & privacy section only renders when
 * `env.features.f9Dashboard && memberId` (see ../page.tsx). When F9 is dark,
 * an unconditional redirect would drop the member onto the hub with no
 * `#data-privacy` anchor and no error (silent no-op). The OLD page called
 * `notFound()` when F9 was off — preserve that clean 404 here.
 */
import { notFound, permanentRedirect } from 'next/navigation';
import { env } from '@/lib/env';

export default async function PortalDataExportPage(): Promise<never> {
  if (!env.features.f9Dashboard) notFound();
  permanentRedirect('/portal/account#data-privacy');
}
