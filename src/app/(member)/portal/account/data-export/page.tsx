/**
 * `/portal/account/data-export` — PRESERVED route (spec §4.5 + §97).
 *
 * The member GDPR data-export panel now lives in the Account hub's
 * Data & privacy section (/portal/account#data-privacy). This legacy route
 * redirects there so any existing deep-link keeps resolving (no 404).
 */
import { redirect } from 'next/navigation';

export default async function PortalDataExportPage(): Promise<never> {
  redirect('/portal/account#data-privacy');
}
