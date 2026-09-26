import type { ReactNode } from 'react';
import type { Viewport } from 'next';
import { redirect } from 'next/navigation';
import { IdleWarningDialog } from '@/components/auth/idle-warning-dialog';
import { AuraDensity } from '@/components/providers/aura-bridge';
import { MemberHeader } from '@/components/layout/member-header';
import { MemberBottomTabs } from '@/components/layout/member-bottom-tabs';
import { MemberCommandPaletteRoot } from '@/components/shell/member-command-palette-root';
import { requireSession } from '@/lib/auth-session';
import { isStaffRole } from '@/modules/auth';
import { enforcePortalPageAccess } from '@/lib/portal-page-access';
import { MarketingAcknowledgementBanner } from './_components/marketing-acknowledgement-banner';

/**
 * Member shell layout (T144 / T024).
 *
 * Auth guard via `requireSession('member')` — redirects to
 * `/portal/sign-in` if there is no valid session. If a staff role
 * (admin/manager) somehow lands on `/portal/*`, we bounce them to
 * their own portal. Members stay.
 *
 * Spec 122 US1: renders the AURA member frame of the portal boards — the
 * header row (`MemberHeader`: brand, pill nav, language, colour scheme,
 * account), the E-Blast banner, `<main>`, and AURA's phone tab bar.
 */

/**
 * `viewport-fit=cover` is scoped to the member portal only (NOT the root
 * layout — 057 review F3). It lets content extend under the iPhone home-bar
 * so the fixed member bottom-tab bar's `env(safe-area-inset-bottom)` padding
 * has room to push the tabs above the home indicator. Next.js resolves the
 * viewport per-segment, so admin/auth surfaces keep the default (no `cover`)
 * and their fixed-bottom UI (e.g. bulk-action-bar) keeps its safe-area inset.
 */
export const viewport: Viewport = {
  viewportFit: 'cover',
};

export default async function MemberLayout({ children }: { children: ReactNode }) {
  const session = await requireSession('member');
  const { user } = session;

  // Cross-portal guard: staff landed on a member route by accident.
  // Domain invariant, not a role literal — a role added to ROLES routes
  // correctly without editing this file (review 016 PR1, sec-2).
  if (isStaffRole(user.role)) {
    redirect('/admin');
  }

  // Task 7 (059-membership-suspension) — SSR-load defense-in-depth for the
  // terminated/suspended portal-scope gate. Runs AFTER the cross-portal
  // guard above (a staff account has no linked member). Next.js 16 does
  // NOT re-run this layout on client-side navigation between sibling
  // portal routes, so this only catches SSR load / refresh / direct nav —
  // the real, always-on enforcement is `requireMemberContext`
  // (`src/lib/member-context.ts`), which every `/api/portal/**` route
  // calls on every request. See `enforcePortalPageAccess` docstring.
  await enforcePortalPageAccess(session);

  return (
    // Spec 122 — member screens use comfortable density (larger touch
    // targets). Locale, calendar, time zone and link come from the root
    // AuraBridge.
    <AuraDensity density="comfortable">
      <div className="chamber-shell flex min-h-screen flex-col lg:[--shell-bar-height:72px]">
        {/* Spec 122 — the header of the portal boards: AURA surface, a hairline
            under it, sticky like AppShell's bar. The Swedish-flag navy chrome
            was dropped on 2026-09-26 in favour of the AURA design. */}
        <header className="sticky top-0 z-10 border-b border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
          <MemberHeader
            tenantName={process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham'}
            user={{ displayName: user.displayName, email: user.email, role: user.role }}
          />
        </header>
        {/* F7 Q15 — E-Blast sending-terms acknowledgement banner (not consent).
            Server component returns null when ineligible (member already
            acknowledged, plan has no eblast quota, or feature flag off).
            U36 — mounted BETWEEN the header and <main>, not inside it, so
            "Skip to main content" bypasses its three controls (SC 2.4.1). It is
            its own named `role="region"` landmark, and its wrapper carries the
            same max-width + page padding it had inside <main> (which has no top
            padding of its own), so the layout does not move. */}
        <MarketingAcknowledgementBanner />
        <main className="flex-1" id="main-content" tabIndex={-1}>
          {children}
        </main>
        {/* 057 — phone tab bar (hidden ≥ lg). AURA BottomNav is fixed and
            renders its own spacer, so the page never sits under it. */}
        <MemberBottomTabs />
        {/* T165 — Idle warning modal fires at 29 min of inactivity. */}
        <IdleWarningDialog portal="member" />
        {/* T086 — ⌘K member command palette (Pay-invoice shortcut). */}
        <MemberCommandPaletteRoot />
      </div>
    </AuraDensity>
  );
}
