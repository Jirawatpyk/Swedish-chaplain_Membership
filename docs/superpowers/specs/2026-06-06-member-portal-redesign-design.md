# Member Portal Redesign — Design Spec

**Date:** 2026-06-06
**Branch:** `057-member-portal-redesign`
**Status:** Design approved (brainstorming) + hardened against a 4-specialist review (UX/IA, architecture, a11y/mobile, PM). Pending implementation plan (writing-plans).
**Scope:** Full professional redesign of the member-facing portal (`/portal/**`). **Presentation + IA only** — reuses existing F3–F9 reads; no new backend features; no admin changes; **no new auth/payment surfaces** (change-password reuses the existing flow).

---

## 1. Context & Goals

The member portal is the chamber's face to its **members** (the actual customers) — login → self-service. It is currently under-designed: a horizontal top-nav with **8 items** (cramped icon-only on mobile), and a **thin dashboard** (welcome + invoice-summary + email). 18 routes with scattered IA.

**Goals:** (1) streamlined professional **nav** (mobile + desktop); (2) a **rich at-a-glance dashboard**; (3) **consolidated IA** (8 → 5 destinations); (4) a consistent professional **design language**.

**Audience:** chamber members; mobile-heavy; occasional self-service. External-facing → first impression matters (go-live invites ~131 members at once — **empty/first-run states are mandatory**, see §4.1).

**Non-goals:** admin changes; new backend features (reuse existing reads); pixel-perfect every micro-route; changing the payment flow (F5) beyond surfacing it; a NEW change-password surface (reuse `/forgot-password`).

---

## 2. Navigation Architecture (DECIDED)

- **Desktop** — horizontal **top-nav** with **4 destinations** (`Dashboard · Profile · Invoices · Benefits`) + a **top-right avatar menu** = the **Account hub** entry.
- **Mobile** — a **bottom tab bar** with **5 tabs** (`Dashboard · Profile · Invoices · Benefits · Account`). No avatar dropdown on mobile; the Account tab is the hub.

**Rationale:** top-nav (few items, full-width content, member-friendly) over sidebar (admin-y); bottom tabs = native-app feel, thumb-reachable; Account is context-appropriate (avatar desktop / tab mobile) — one destination, one affordance per viewport, **no same-screen duplication**.

### 2a. NavConfig model (RESOLVED — review M3)
The current `NavConfig`/`NavItem`/`NavGroup` (`src/config/nav.ts`) supports `href` link items only — not display-context (desktop-nav vs mobile-tab) nor avatar action items (sign-out is a POST, not a link). **Decision (Option C — simplest, no breaking change):**
- Keep `memberNavConfig` as the source for the **desktop top-nav** (4 items: Dashboard/Profile/Invoices/Benefits).
- Add a **separate `memberBottomTabItems` constant** for the 5 mobile tabs (the 4 + Account).
- The **avatar Account menu extends the existing `UserMenu`** component (`src/components/shell/user-menu.tsx`, which already owns sign-out) — do NOT hand-roll. It is built on shadcn `DropdownMenu` (Radix) for free ESC / focus-return / `role=menu` (review a11y-4).

---

## 3. Information Architecture (8 → 5 destinations)

| Old nav item / route | New home | Route handling |
|---|---|---|
| Dashboard | **Dashboard** (destination) | — |
| Profile | **Profile** (destination) | — |
| `/portal/profile/directory` (F9 directory opt-in) | **Profile** → "Directory listing" section/link (review M-3) | route preserved |
| Invoices | **Invoices** (destination) | — |
| Benefits | **Benefits** (destination) | — |
| **E-Blast** (`/portal/benefits/e-blasts`) | tab inside **Benefits** (labelled **"Broadcasts"**, not jargon "E-Blast" — review S-6) | route preserved; Benefits tab `activePattern` prefix-matches it |
| `/portal/broadcasts/new`, `/portal/broadcasts/[id]` (compose/detail) | reached from the Broadcasts tab; **routes stay at `/portal/broadcasts/**`** | Benefits-tab active-state matcher MUST also match `/portal/broadcasts/**` (review M-2) |
| **Timeline** | "Recent activity" **section on Dashboard** + "view all" → `/portal/timeline` (route stays; no email CTA depends on it) | route preserved |
| **Renewal prefs** (`/portal/preferences/renewals`) | linked from **Account** hub | **ROUTE PRESERVED — renewal-reminder emails hardcode this URL** (review M-1, see §4.5) |
| Renewal flow (`/portal/renewal/[memberId]`) | Dashboard "Renew" CTA (conditional) | **ROUTE PRESERVED — email redeem-link + use-case hardcode it** |
| `/portal/account/data-export` | **Account** → Data & privacy | route preserved |
| Account | **Account** hub (avatar desktop / tab mobile) | — |

**Route-preservation principle:** any route referenced by an email CTA, an application-layer hardcode, or an external deep-link MUST keep working. Moving its *nav entry* is fine; removing/renaming the *route* is a ship blocker.

---

## 4. Page Designs

### 4.1 Dashboard (`/portal`) — at-a-glance hub

- **Header**: `สวัสดี {name}` + member-number chip (`SCCM-NNNN`) + plan chip + status chip. **Remove the `versionBadge`** (review SG-6).
- **3 stat cards**:
  - **Membership** — uses `loadMemberRenewalStatus` with **`memberId` resolved from session** (`findByLinkedUserId`, never URL) (review M-2). Shown **conditionally + variant by status**: `upcoming` (neutral) / `action-needed` (warning, e.g. outstanding invoice) / `overdue` (destructive). When renewal is far off, the card shows membership status (plan, "active") rather than a stale countdown (review M-1, SG-2).
  - **Outstanding balance** — ฿ + invoice count + due date.
  - **Benefits** — **under-use highlight, NOT an aggregate %** (review S-1): e.g. "2 benefits under-used" (warning) or "All benefits on track" (ok), aligned with `computeBenefitUsage`'s under-use logic.
- **Quick actions** (transactional only): Pay invoice (primary) · View benefits · **Renew (conditional, same threshold as the Membership card; hide/disable when not due)** · Edit profile.
- **2-col**: Latest invoices (3 + "view all") | Benefits quota (bars + "view all").
- **Recent activity**: timeline preview (3–4 events + "view all" → `/portal/timeline`). **MUST use the same member-permission event filter as `/portal/timeline`** — member-relevant events only (invoice paid/issued, broadcast sent, event attended); exclude admin-only/system events that would confuse or leak (review S-2).
- **Empty / first-run state (MANDATORY — review S-5 + PM)**: a member with no invoices / unused quota / empty activity MUST see friendly, actionable empty states (illustrated, localised, CTA — per `docs/ux-standards.md`), NOT zeroes + blank lists. Go-live invites ~131 members simultaneously → all land on an empty dashboard first.
- **Data sources (existing, reuse)**: invoice reads (F4), `computeBenefitUsage` (F9 insights barrel), `loadMemberRenewalStatus` (F8 renewals barrel), timeline (F9). All RLS-safe via `runInTenant`, `memberId` from session. **Wrap reused reads in React `cache()`** for per-request dedup (Dashboard + Profile both read renewal/benefits — review S-2 architect).
- **Mobile reflow**: stat cards → 1 column; quick actions → 2×2 grid; panels stack; **content gets `padding-bottom` ≥ bottom-tab height** (see §7).

### 4.2 Profile (`/portal/profile`) — my membership

- Member-facing version of the admin member-detail (Option C structure) **without** admin actions / renewal-triage.
- Header (company + `SCCM-NNNN` + status) → **Organisation** card → **Membership** card → **Contacts** card (primary + others; "invite contact" reuses the existing `/portal/contacts/invite` flow → `/invite/[token]` — review SG-4) → **Directory listing** section (F9 opt-in, from `/portal/profile/directory` — review M-3) → `[Edit profile]` → `/portal/edit`.
- **Reuse `DetailField`** (`src/components/members/detail-field.tsx`) — note the current profile page uses inline `<dt>/<dd>`; this is a **refactor**, not a copy (review S-3 architect).
- **Heading rule (MUST — review a11y-6):** section titles are **real `<h2>`**, NOT `CardTitle` (which renders a `<div>`). The admin member-detail shipped an h1→h3 skip from exactly this; do NOT reproduce it. Outline must be h1 (PageHeader) → h2 (sections).

### 4.3 Invoices (`/portal/invoices`) — billing + pay

- **Summary**: outstanding total. **List**: number · date · status · amount · `[Pay]` — apply the same a11y/CLS treatment as the admin invoice table (table `aria-label`, matched skeleton). **Detail**: invoice view + Pay online (F5 PromptPay/card) + download PDF. Largely exists → design-language + a11y parity.

### 4.4 Benefits (`/portal/benefits`) — entitlements + Broadcasts

- **Tabs**: `[Benefits] [Broadcasts]` (label "Broadcasts" not "E-Blast" — review S-6; i18n key reuses `nav.member.broadcasts`).
- **Benefits tab**: quota overview (entitlement vs usage bars) + under-use warning (existing F9 `BenefitUsageCard`).
- **Broadcasts tab**: quota + `[Compose]` CTA + sent history. Compose/detail navigate to `/portal/broadcasts/new` + `/portal/broadcasts/[id]` (routes stay); **the Benefits tab keeps its active state while on `/portal/broadcasts/**`** (review M-2).

### 4.5 Account (`/portal/account`) — settings hub

- **Account**: email (display) · **change password → link to the existing `/forgot-password` flow** (NOT a new inline form — keeps scope presentation-only; review S-3 ux).
- **Renewal preferences**: **the `/portal/preferences/renewals` route is PRESERVED** (renewal-reminder emails hardcode `${baseUrl}/portal/preferences/renewals` in `dispatch-one-cycle.ts` + `retry-failed-reminders.ts` + the email layout). The Account hub **links to / embeds** it; if it is instead made a redirect to `/portal/account#renewal-prefs`, the route MUST still resolve (redirect, not 404) AND the use-case hardcodes updated. **A 404 here breaks PDPA opt-out (ship blocker — review M-1).**
- **Data & privacy**: GDPR data-export (from `/portal/account/data-export`).
- **Appearance**: theme (light/dark) · **Sign out**.
- **Canonical hub = the `/portal/account` page** (one URL). Desktop avatar dropdown items link to the **same `/portal/account` URL / section anchors** (no modal, no shallow route) so share-link / back-button / deep-link work; mobile Account tab opens it directly. Both render from one source (review S-4).

---

## 5. Design Language (professional)

Consistent **card** styling (the dashboard sets the tone). **Stat cards** (label + big value + sub). **Quota bars** — visible text value (`2/5`) + `role="progressbar"` aria (NOT colour/length alone — review a11y-5). **Chips/badges** — non-colour-only text labels (WCAG 1.4.1). Clear hierarchy h1 → h2 (real headings). Reuse primitives + the admin lean-table a11y patterns.

---

## 6. Components & Reuse

**New:** `bottom-tab-bar` (mobile); redesigned **top-nav** (desktop, evolve `MemberNav`); **avatar Account menu** (extend `UserMenu`, shadcn `DropdownMenu`); dashboard primitives (`stat-card`, `quota-bar`, `quick-action`, `activity-feed`); Profile section components.

**Reuse:** `PageHeader`, `Card`, `Badge`, `Button`, `DetailField`, the localised date helper, `BenefitUsageCard` (compact mode — pass a **portal** `previewHref="/portal/benefits"`, not the admin path — review 1b), `InvoicesSummaryCard` (**move from `portal/invoices/_components/` → `src/components/portal/` as a shared component** since the Dashboard also uses it — review S1 architect), the timeline preview. Reads via module **barrels** only (`@/modules/insights`, `@/modules/renewals`) — Clean Architecture (Principle III). `RenewalHealthCard` reuse must override the admin `viewHref` (`/admin/renewals` → `/portal/renewal/{memberId}`).

**i18n namespaces (review V):** new labels under `portal.dashboard.*`, `portal.account.*`, `portal.profile.*`, `portal.benefits.*`; bottom-tab labels may need a `.short` variant (TH "สิทธิประโยชน์"/"บัญชีผู้ใช้" overflow a 320px tab — review SG-5) → use short TH labels in the tab with the full label as `aria-label`.

---

## 7. Accessibility & i18n (MUST-level requirements)

- **Bottom tab bar**: touch targets **≥44px**; `aria-current="page"` on active; **visible text label under each icon** (NOT `sr-only` like the current `MemberNav` — review a11y-3); unique `<nav aria-label>`; **`env(safe-area-inset-bottom)` padding + `viewport-fit=cover`** (iPhone home-bar — review a11y-1); the fixed bar requires **`<main>` `padding-bottom` = tab-bar height** so it never obscures the last row / Sign-out / Pay (WCAG 2.4.11 Focus Not Obscured — review a11y-2 + architect S4).
- **Top-nav (desktop)**: `aria-current`, keyboard, focus-visible.
- **Avatar dropdown**: shadcn `DropdownMenu` (Radix) — ESC, focus-return, `role=menu` (review a11y-4).
- **Mobile reflow (320px)**: dashboard 3-stat / 2-col / quick-actions specified to 1-col / 2×2; no horizontal overflow.
- **Headings**: h1 (PageHeader) → h2 (real `<h2>`, never `CardTitle`-div) — every section a landmark + accessible name.
- **i18n EN/TH/SV** for every new label; **BE date display-only for `th`** (off-by-543 is a ship blocker).

---

## 8. Scope & Phasing (input for writing-plans)

Restructured to **3 deliverables** (review PM) so member value ships first:

- **D1 — pre-launch member value (highest priority):** Nav shell (top-nav + bottom-tab + avatar; **façade — wire hrefs to existing pages first**) + **Dashboard** redesign (incl. empty/first-run states) + **Profile** redesign. This is the bulk of the visible win for the ~131 launch invitees.
- **D2 — fast-follow:** **Benefits** (tabs + Broadcasts) + **Account** hub consolidation (incl. renewal-prefs preservation, data-export, change-password link).
- **D3 — polish:** **Invoices** design-language + a11y parity. *(Consider pulling D3 forward / parallel with D1 so the Dashboard `InvoicesSummaryCard` is consistent — review G3.)*

Each deliverable: TDD, a11y axe pass, i18n parity, a **cross-tenant integration test** (member A never sees member B's renewal/benefit/invoice data — Principle I Review-Gate blocker).

---

## 9. Dependencies, Risks & Out-of-Scope

- **Branch / merge order (review PM-1):** `057` is cut from `056` (admin UX overhaul, **unmerged**) to inherit shared components (`DetailField`, `BenefitUsageCard` compact, `loadMemberRenewalStatus`). Merge order: land **`056` → `main` first**, then rebase `057`. Resolve i18n-key conflicts at merge (056, 015, and 057 all add keys).
- **Risk — F9 benefit-usage data (review PM-3):** verify during planning that `computeBenefitUsage` returns complete data for the Dashboard stat (it already backs `/portal/benefits`); if any quota metric is "not yet computed", show a placeholder rather than a wrong number.
- **Risk — duplicate reads:** Dashboard + Profile both read renewal/benefits → use React `cache()` per-request dedup.
- **Out of scope:** admin; new backend features; new change-password surface (reuse `/forgot-password`); the F5 payment flow itself (only surfaced); underlying routes preserved per §3.

---

## 10. Success Criteria (measurable — review PM-2)

- **a11y:** `@axe-core/playwright` reports **0 violations** on every redesigned portal page (run on preview deploy) — incl. heading-order, target-size, aria-current, focus-not-obscured.
- **i18n:** `pnpm check:i18n` **0 missing keys** across EN/TH/SV for all new labels.
- **Responsive:** **no horizontal overflow at 320px** on every portal page; bottom-tab does not obscure content (verified `<main>` padding).
- **Tenant isolation:** a cross-tenant integration test passes (member A ≠ member B data) for each new member-facing read surface.
- **Perf:** Dashboard server render within the portal-composite TTFB budget (target **p95 < 600 ms** on preview; confirm against `docs/observability.md`).
- **Route safety:** every email-CTA / hardcoded route in §3 still resolves (no 404) — a regression check for `/portal/preferences/renewals` + `/portal/renewal/[memberId]`.

---

## 11. Open Decisions Resolved by This Revision

M-1 renewal-prefs route preserved · M-2 broadcasts route + Benefits-tab active matcher · M-3 directory + renewal CTA in IA · NavConfig Option C · loadMemberRenewalStatus session-memberId + portal viewHref · empty/first-run states mandatory · Benefits stat = under-use highlight · activity event whitelist · "Broadcasts" label · change-password = `/forgot-password` link · DetailField refactor + real-h2 headings · bottom-tab safe-area + main padding + visible labels · avatar = shadcn DropdownMenu via UserMenu · success criteria added · branch/merge order documented.
