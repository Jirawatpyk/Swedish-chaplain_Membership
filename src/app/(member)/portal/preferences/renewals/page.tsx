/**
 * `/portal/preferences/renewals` — PRESERVED route (spec §4.5 + §97).
 *
 * Renewal-reminder emails hardcode `${baseUrl}/portal/preferences/renewals`
 * (renewals/.../dispatch-one-cycle.ts + retry-failed-reminders.ts +
 * base-renewal-layout.tsx). This route is PERMANENTLY moved — the opt-out UI
 * now lives in the consolidated
 * Account hub, so this route permanently redirects (308, browser-cacheable)
 * to that section. A 404 here would break the PDPA opt-out path (ship
 * blocker). Do NOT change the email hardcodes — this redirect keeps them
 * working, now without re-paying the hop on every email-CTA click.
 */
import { permanentRedirect } from 'next/navigation';

export default async function RenewalPreferencesPage(): Promise<never> {
  permanentRedirect('/portal/account#renewal-prefs');
}
