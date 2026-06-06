# Member Portal Redesign — Design Spec

**Date:** 2026-06-06
**Branch:** `057-member-portal-redesign`
**Status:** Design approved (brainstorming). Pending implementation plan (writing-plans).
**Scope:** Full professional redesign of the member-facing portal (`/portal/**`). Presentation + IA only — reuses existing F3–F9 reads; no new backend features; no admin changes.

---

## 1. Context & Goals

The member portal is the chamber's face to its **members** (the actual customers) — login → self-service. It is currently under-designed:

- **Nav**: a horizontal top-nav with **8 items** (`MemberNav` in the header). On mobile it collapses to icon-only and is cramped at 320px.
- **Dashboard** (`/portal`): thin — a welcome header, an invoice-summary card, and a contact (email) card. No at-a-glance status.
- **18 routes** with scattered IA (e.g. renewal-prefs and data-export are reachable only by direct URL / buried).

**Goals**

1. Streamlined, professional **navigation** that works on mobile and desktop.
2. A **rich dashboard** that surfaces everything a member cares about in one screen.
3. **Consolidated IA** — fewer top-level destinations, related things grouped.
4. A consistent, professional **design language** across all portal pages.

**Audience:** chamber members; mobile-heavy; occasional self-service use. External-facing → first impression matters for adoption.

**Non-goals:** changing the admin (`/admin/**`); new backend features (reuse existing reads); pixel-perfect treatment of every micro-route; changing the payment flow (F5) beyond surfacing it.

---

## 2. Navigation Architecture (DECIDED)

- **Desktop** — horizontal **top-nav** with **4 destinations** (`Dashboard · Profile · Invoices · Benefits`) + a **top-right avatar menu** that is the **Account hub** (account settings, renewal prefs, data export, theme, sign-out).
- **Mobile** — a **bottom tab bar** with **5 tabs** (`Dashboard · Profile · Invoices · Benefits · Account`). No avatar dropdown on mobile; the **Account tab** is the hub.

**Rationale**

- Top-nav over sidebar: the portal has few destinations, top-nav keeps content full-width and feels member-friendly (consumer app) rather than admin-tool. Sidebar (admin pattern) is reserved for the 14-item admin.
- Bottom tabs on mobile: native-app feel, thumb-reachable, no cramped 320px icon row.
- **Account is context-appropriate, not duplicated**: it is the avatar menu on desktop and a bottom tab on mobile — one destination, one affordance per viewport (resolves the prior avatar-vs-nav "Account" duplication).

---

## 3. Information Architecture (8 → 5 destinations)

| Old nav item | New home |
|---|---|
| Dashboard | **Dashboard** (destination) |
| Profile | **Profile** (destination) |
| Invoices | **Invoices** (destination) |
| Benefits | **Benefits** (destination) |
| **E-Blast** | tab/section inside **Benefits** (it is a quota-bearing benefit) |
| **Timeline** | "Recent activity" **section on the Dashboard** (+ "view all" → the full timeline route, which stays as a route but is no longer a nav item) |
| **Renewal prefs** | **Account** hub |
| Account | **Account** hub (avatar desktop / tab mobile) |
| (Data export — was buried) | **Account** hub (Data & privacy) |

Routes whose content **moves into another page** keep their underlying route alive where it still serves email-CTA deep-links (e.g. `/portal/timeline`, the renewal flow) — only their **nav entry** changes.

---

## 4. Page Designs

### 4.1 Dashboard (`/portal`) — at-a-glance hub

- **Header**: `สวัสดี {name}` + member-number chip (`SCCM-NNNN`) + plan chip + status chip.
- **3 stat cards**: Membership (renews in N days / expiry) · Outstanding balance (฿ + invoice count + due date) · Benefits used (% + e.g. `E-Blast 2/5`).
- **Quick actions**: Pay invoice (primary) · View benefits · Renew · Edit profile.
- **2-col**: Latest invoices (3 + "view all") | Benefits quota (usage bars + "view all").
- **Recent activity**: timeline preview (3–4 events + "view all" → timeline route).
- **Data sources (existing)**: invoices (F4), `computeBenefitUsage` (F9), `loadMemberRenewalStatus` (F8), timeline (F9).
- **Mobile reflow**: stat cards → 1 column; quick actions → 2×2 grid; panels stack.

### 4.2 Profile (`/portal/profile`) — my membership

- A **member-facing** version of the admin member-detail (the just-shipped Option C structure), **without** admin actions / renewal-triage.
- Header (company + `SCCM-NNNN` + status) → **Organisation** card (country, tax id, address, website, founded) → **Membership** card (plan, year, member-since, renewal) → **Contacts** card (primary + others; invite contact) → `[Edit profile]` → `/portal/edit`.
- **Reuse**: `detail-field` component, the localised date helper, the Option C grouping pattern.

### 4.3 Invoices (`/portal/invoices`) — billing + pay

- **Summary**: outstanding total.
- **List**: number · date · status · amount · `[Pay]` — apply the same **a11y/CLS** treatment as the admin invoice table (table `aria-label`, matched skeleton).
- **Detail** (`/portal/invoices/[id]`): invoice view + **Pay online** (F5 PromptPay / card) + download PDF.
- Largely exists → apply the new design language + a11y parity.

### 4.4 Benefits (`/portal/benefits`) — entitlements + E-Blast

- **Tabs**: `[Benefits] [E-Blast]`.
- **Benefits tab**: quota overview (entitlement vs usage bars) + under-use warning (existing F9 `BenefitUsageCard`).
- **E-Blast tab** (moved from nav): E-Blast quota + `[Compose]` CTA + sent history (the current `/portal/benefits/e-blasts` content surfaced as a tab).

### 4.5 Account (`/portal/account`) — settings hub (NEW consolidation)

- **Account**: email (display) · change password.
- **Renewal preferences** (moved from `/portal/preferences/renewals`): reminder opt-out.
- **Data & privacy** (moved from `/portal/account/data-export`): GDPR data-export request.
- **Appearance**: theme (light/dark).
- **Sign out**.
- **Canonical hub = the `/portal/account` page.** On **desktop**, the top-right avatar opens a dropdown listing these items as quick links + an inline theme toggle + sign-out (the dropdown's links open the corresponding hub sections). On **mobile**, the Account bottom tab opens the hub page directly. Both affordances render from one source so they never drift.

---

## 5. Design Language (professional)

- Consistent **card** styling (the dashboard sets the tone): bordered, rounded, generous padding/spacing.
- **Stat cards** (label + big value + sub) for at-a-glance metrics.
- **Quota bars** for benefit usage.
- **Chips/badges** for status — non-colour-only text labels (WCAG 1.4.1).
- Clear hierarchy: page `<h1>` (PageHeader) → section `<h2>` → sub.
- Reuse existing primitives + the admin lean-table a11y patterns.

---

## 6. Components & Reuse

**New**
- `bottom-tab-bar` (mobile nav, 5 tabs, `aria-current`, ≥44px targets).
- redesigned **top-nav** (desktop, 4 items) — evolve the existing `MemberNav`.
- **avatar Account menu** (desktop dropdown → Account hub).
- dashboard primitives: `stat-card`, `quota-bar`, `quick-action`, `activity-feed`.
- Profile section components (member-facing).

**Reuse**
- `PageHeader`, `Card`, `Badge`, `Button`, `detail-field`, the localised date helper, `BenefitUsageCard`, `InvoicesSummaryCard`, the timeline preview.
- Reads: `loadMemberRenewalStatus` (F8), `computeBenefitUsage` (F9), invoice reads (F4) — all RLS-safe via `runInTenant`.
- `memberNavConfig` (`src/config/nav.ts`) — restructure to the 4 top-nav destinations + the bottom-tab set; Account via avatar.

---

## 7. Accessibility & i18n

- **WCAG 2.1 AA**: bottom tabs (touch targets ≥44px, `aria-current="page"`); top-nav (`aria-current`); avatar menu (keyboard + focus management); heading hierarchy h1→h2; non-colour status; **mobile reflow** (no horizontal overflow at 320px).
- **i18n EN/TH/SV** for every new label (nav, dashboard, account hub, tabs). BE date display-only for `th` (off-by-543 is a ship blocker).

---

## 8. Scope & Phasing (input for writing-plans)

1. **Nav** — top-nav (desktop, 4) + bottom-tab bar (mobile, 5) + avatar Account menu; IA wiring (E-Blast→Benefits tab, renewal-prefs→Account, data-export→Account, Timeline→Dashboard section; preserve underlying routes).
2. **Dashboard** redesign (header, stat cards, quick actions, 2-col, activity).
3. **Profile** redesign (member-facing member-detail).
4. **Benefits** (tabs + E-Blast) + **Account** hub consolidation.
5. **Invoices** design-language parity + a11y.

---

## 9. Out of Scope / Risks

- No new backend features; reads reuse F3–F9.
- No admin changes.
- Underlying routes preserved where they still serve email-CTA deep-links (timeline, renewal flow).
- Payment flow (F5) unchanged — only surfaced.
- **Risk**: the avatar Account menu and the Account page must share content (single source) so desktop/mobile stay in sync. **Risk**: bottom-tab 320px layout — keep to 5 tabs (no "More" needed at 5).
