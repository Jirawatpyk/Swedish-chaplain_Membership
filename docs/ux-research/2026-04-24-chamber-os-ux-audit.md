# Chamber-OS — UX Audit, Personas, Journeys & Roadmap

**Date**: 2026-04-24
**Scope**: Chamber-OS platform — F1 Auth, F2 Plans, F3 Members, F4 Invoices + layout (006) already shipped or review-ready on branch; F5 Online Payment currently on `009-online-payment`.
**Method**: Expert heuristic review (Nielsen's 10 + WCAG 2.1/2.2 AA), artefact synthesis from docs + source (no live user interviews yet — see § 7).
**Evidence base**: `docs/phases-plan.md`, `docs/ux-standards.md`, `docs/membership-benefits-analysis.md`, `docs/smart-chamber-features.md`, `docs/event-integration-analysis.md`, `docs/email-broadcast-analysis.md`, `src/app/(staff)/admin/**`, `src/app/(member)/portal/**`, `src/components/layout/**`, `src/config/nav.ts`, `CLAUDE.md`.
**Confidence**: Medium-High on shipped surfaces (code + docs available), Hypothesis-only on future flows (F5–F14) — flagged per-item.

---

## § 1 Executive Summary

- **Enterprise UX foundation is strong** — `docs/ux-standards.md` is one of the most complete playbooks I have audited (20 sections, covers shimmer/min-delay, reduced-motion, idle-warning, Fitts's-law footer rules, icon-trigger zones). Evidence traceability is excellent; this reduces the usual "the UX vision lives in one designer's head" risk.
- **Critical gap on member-facing landing** — `/portal` still leads with a roadmap list ("F4, F5, F6…") referencing internal phase codes (`src/app/(member)/portal/page.tsx:48-76`). This is staff-centric copy on a member surface. Evidence: lines 48-79 render literal `F4/F5/F6` badges and `t('roadmap.invoices.title')` strings. **Severity: Major**.
- **Staff sidebar is shallow and will not scale** — `src/config/nav.ts:65-118` shows a flat 5-item primary group (Dashboard, Plans, Members, Invoices, Users) + one Settings child. With F5–F9 arriving (Payments, Events, E-Blast, Renewal, Dashboard, Directory, Audit), IA needs grouping + priority redesign before F6/F7 land, or the sidebar will become a 15-item flat list.
- **No Credit Notes nav entry** despite the route existing (`src/app/(staff)/admin/credit-notes/page.tsx`) — discoverable only via invoice detail page. **Severity: Major** (findability).
- **No "Benefits" surface yet** — `docs/smart-chamber-features.md` § 2 designs a per-member benefit-usage dashboard; this is the product's **core competitive moat vs GlueUp/Wild Apricot** yet is not shipped and not on F5 path. Risk: members renew without seeing value → churn.
- **Language/locale switcher placement** — per `ux-standards.md` § 12.1 the switcher lives in the user menu, but I found no matching `locale-switcher` component under `src/components/shell/**`. Need to verify it ships; if absent, TH/SV members cannot change locale without URL surgery. **Severity: Major if missing**.
- **Admin has no at-risk member / renewal dashboard** — planned as F8/F9 but no placeholder or counter on `/admin` (`src/app/(staff)/admin/page.tsx:42-60` is a static card of roadmap phases). Managers (treasurer read-only) cannot see finance KPIs at all yet.
- **Receipts/invoices in member portal lack "Pay" affordance** — F4 shipped read-only; the bridge to F5 (online payment) is the single most important journey for the product and deserves its own IA treatment, not just a button inside invoice detail.
- **Heavy reliance on async email flows** (invoicing dispatcher, invitation, reset, F7 E-Blast) — UX standard § 4.4 already mandates resend affordance + delivery-state warnings; this is good. Extend to F5 receipt email after successful payment.
- **Top roadmap call**: ship **F5 Online Payment + Member Benefit Dashboard (smart #1)** as the next two value-delivery flows; everything else is table-stakes. See § 6.

---

## § 2 Heuristic Evaluation Findings

Severity scale: **Critical** (blocks task / legal / a11y violation) · **Major** (significantly hurts efficiency, findability, or trust) · **Minor** (polish, inconsistency).

| # | Heuristic | Issue | Severity | Location (evidence) | Recommendation |
|---|-----------|-------|----------|---------------------|----------------|
| H1 | #1 Visibility of system status | Staff dashboard `/admin` shows a static roadmap card, no real status (member count, overdue invoices, at-risk renewals, outbox health). Manager persona has no landing value. | Major | `src/app/(staff)/admin/page.tsx:42-60` (ROADMAP_PHASES static array) | Replace card with 4-tile KPI grid: Total active members · Invoices due this week · Overdue · Outbox health (already have `outbox-health-badge.tsx`). Gate behind F9 but ship a lean v0 now. |
| H2 | #1 Visibility of system status | Member portal landing uses internal phase codes (F4/F5/F6) as UI badges, not product language. | **Major** | `src/app/(member)/portal/page.tsx:48-79` | Replace badge numbers with icons + plain labels ("Invoices", "Events", "Online payment"). Move "what's coming" to a dismissible info banner. |
| H3 | #2 Match system ↔ real world | "Plans" in staff nav is internally consistent but members call these "Membership tiers" / "packages". | Minor | `src/config/nav.ts:76-80` (`nav.staff.plans`) | Keep "Plans" internally (industry term); ensure member-facing copy uses "Membership tier" / "Package" (per `_2026_Membership Package.pdf`). |
| H4 | #3 User control & freedom | No undo surface for destructive actions despite `ux-standards.md § 5.3` listing it as "where applicable". F3 archive + F4 void are irreversible with confirmation only. | Major | `ux-standards.md` § 5.3 vs F3 archive use-case | Add "Undo" toast (8s) for: member archive, plan deactivate, invoice email resend. Keep hard-typed confirmation for truly irreversible (void invoice, delete draft). |
| H5 | #4 Consistency & standards | Staff nav has a "Settings" section with **one child** (Invoicing). Fee Config was folded into Invoice Settings but the section heading remains, creating a dangling group. | Minor | `src/config/nav.ts:101-117` (comment "R7 consolidation … orphaned") | Either (a) flatten: move "Invoice Settings" into primary group under a `SettingsIcon`, or (b) commit to the Settings group and plan F5/F9 children (Payments, Branding, Notifications). |
| H6 | #4 Consistency & standards | "Credit notes" route exists (`admin/credit-notes`) but has **no sidebar entry**. Users reach it only via invoice → overflow menu. | **Major** | `src/config/nav.ts:65-100` vs `src/app/(staff)/admin/credit-notes/page.tsx` | Add Credit Notes as a sibling of Invoices under a "Finance" subgroup; or as a tab on `/admin/invoices`. |
| H7 | #5 Error prevention | Email-dependent waiting screens mandate resend + bounce warnings (`ux-standards.md § 4.4`). F5 payment-confirmation email path should inherit this pattern — NOT yet enforced in the new `src/modules/payments` (branch 009). | Major | `git status` shows `src/modules/payments/index.ts` + `src/app/api/webhooks/stripe/` untracked | Add `§ 4.4` compliance to F5 `spec.md` before Review-Gate: post-payment receipt email needs resend at 60s + delivery-state banner. |
| H8 | #6 Recognition rather than recall | No command palette surface appears in staff sidebar trigger (Cmd+K is documented in `ux-standards.md § 7.4` as "F2+ stub in F1"). Discoverability depends on users guessing the shortcut. | Major | `src/components/command-palette/` exists; no visible "⌘K" hint in `staff-sidebar.tsx` | Add a slim search-input-styled "⌘K Search" trigger in the sidebar header or top-of-content, visible on hover at minimum (matches Linear, Notion, Vercel). |
| H9 | #7 Flexibility & efficiency | Bulk actions shipped (F3 smart #7) but no bulk for F4 invoices (send/resend/mark-paid) or F2 plans (activate/deactivate). | Minor (now) / Major (at scale > 100 members) | F3 `members/_components` has bulk; F4 `invoices/_components` lacks equivalent | Add bulk-send and bulk-mark-paid to invoice table before 2027 renewal season. |
| H10 | #8 Aesthetic & minimalist | PageHeader renders `subtitle` as `<div>` because `ReactNode` is passed from loading.tsx skeleton — deliberate but awkward. | Minor | `src/components/layout/page-header.tsx:53-60` (comment explains) | Accept. The workaround is correct (avoids `<p><div>` hydration error). No action needed, but document in `docs/shadcn-customizations.md`. |
| H11 | #9 Help users recognize, diagnose, recover from errors | No empty-state catalogue visible for invoice + credit-note tables when tenant has 0 rows. `ux-standards.md § 3` mandates these. Need verification. | Major (if absent) | `src/app/(staff)/admin/invoices/page.tsx` + `credit-notes/page.tsx` | Audit every table page for `EmptyState` usage; add where missing. Acceptance criteria in `ux-standards.md § 3` applies. |
| H12 | #10 Help & documentation | `?` shortcut for keyboard help is promised in `ux-standards.md § 7.4` but no implementation evident. | Minor | No `keyboard-help-dialog` under `src/components/shell/` | Ship a minimal help dialog enumerating Cmd+K, Esc, Alt+U, form Enter — triggered by `?` globally and a "Keyboard shortcuts" item in user menu. |
| H13 | #10 Help & documentation | New members onboarding flow (invitation → first login → profile complete) has no guided tour or inline checklist. | Major | `src/app/(auth-public)/invite/` exists but lands user on generic dashboard | Add a first-time checklist card: "Complete your company profile · Add co-contacts · View your benefits · Download first invoice". See Journey § 4.1. |
| A1 | WCAG 2.1 AA · 1.4.3 Contrast | `ux-standards.md § 1.2` states "4.5:1 verified by automated tests" — good. | ✓ (Suggestive) | e2e tests on axe-core tagged `@a11y` | Continue; add visual regression for dark-mode token coverage (Phase 5B). |
| A2 | WCAG 2.1 AA · 2.4.7 Focus Visible | Focus ring spec present `ux-standards.md § 7.5`. | ✓ | Global CSS | Verify on sidebar collapsible variants — collapsed icon-only state must still show ring at 3:1 on sidebar-background. |
| A3 | WCAG 2.1 AA · 3.3.1 Error identification | Inline form errors defined (`§ 4.1`), `aria-invalid` + `aria-describedby`. | ✓ | — | Continue. |
| A4 | WCAG 2.2 AA · 2.4.11 Focus Not Obscured | F3 spec explicitly adopts SC 2.4.11. | ✓ | `CLAUDE.md` · F3 line item | Extend adoption to F4 forms (invoice line editor) + F5 payment dialog. |
| A5 | WCAG 2.2 AA · 2.5.8 Target Size (≥24×24) | F3 e2e asserts this; `ux-standards.md § 9.1` mandates 44×44 on mobile. | ✓ | — | Verify the 32×32 `ghost icon` overflow trigger (`ux-standards.md § 19`) passes 2.5.8 minimum on desktop — it does (24 is the floor). |
| A6 | WCAG 2.1 AA · 1.4.4 Resize Text & Reflow | `ux-standards.md § 12.2` says "layouts accommodate +50% TH length". | ✓ (Suggestive — needs verification in staging) | — | Add Playwright locale-visual-diff between EN and TH on every page (caught once by the label-gap incident in 006). |
| A7 | WCAG 2.1 AA · 2.1.1 Keyboard | Command palette, skip-to-content, idle warning all specced. | ✓ | `src/components/shell/skip-to-content.tsx` | Verify **every table row** has keyboard row-activation (Enter on focused row opens detail) — common oversight in TanStack Table v8. |
| A8 | WCAG 2.1 AA · 4.1.3 Status Messages | Toasts via Sonner, announced politely. | ✓ | — | Confirm `sonner` config uses `aria-live="polite"` for success, `aria-live="assertive"` for error (Sonner default is OK but worth asserting in a test). |
| X1 | PDPA + GDPR · Consent & export | `smart-chamber-features.md` #21 GDPR self-service export is Phase 3. No current surface for member data export. | Major (compliance risk) | No `/portal/privacy` route in current tree | Ship a minimal "Download my data" button on `/portal/account` in F5 window, even if it just triggers an email to admin — closes the 30-day SAR window risk. |

**Summary**: 0 Critical, 8 Major, 4 Minor, 8 ✓. Biggest thematic risks are (a) member portal still looks like a staff roadmap placeholder, (b) staff IA does not yet express the product's roadmap, (c) no benefit-value surface despite being the competitive moat.

---

## § 3 Personas

Personas grounded in: `docs/phases-plan.md` R4 (3 roles), `docs/membership-benefits-analysis.md` (6 corporate + 3 partnership tiers), SweCham's real tenant shape (~131 members / 164 contacts per CLAUDE.md, bilingual TH/SV context). Confidence: **Suggestive — needs validation** via 6–8 interviews (see § 7).

### P1 — "Khun Nok" · Chamber Admin (staff role: `admin`)

| Dimension | Detail |
|---|---|
| Role | Operations Manager at SweCham, 1 of 2 staff |
| Age / tenure | 38, 6 years at SweCham |
| Tech literacy | Medium — comfortable with Excel, Google Workspace, Canva, Mailchimp-level tools; not a developer |
| Locale | Thai primary, fluent English, reads some Swedish |
| Typical day | 09:00 invoice runs → 10:00 member queries → 13:00 event RSVPs via EventCreate → 15:00 chase overdue → 17:00 E-Blast queue |
| Goals | (G1) Replace the Excel workbook completely. (G2) Never miss a renewal. (G3) Deliver every paid benefit so members renew. (G4) Bilingual tax-compliant invoices first try. |
| Pain points | (P1) Excel copy-paste errors. (P2) Forgetting E-Blast quotas. (P3) Manual BE↔CE date conversion. (P4) Swedish members complain UI is "English only" — needs SV surfaces. (P5) Juggles TH Revenue numbering sequence manually. |
| Motivations | Recognition from the board; fewer late-night spreadsheet sessions |
| Key jobs-to-be-done | "When it's renewal season, help me see who is at risk, so I can intervene with personal outreach before they lapse." |
| Anti-goals | Doesn't want to learn SQL, doesn't want another portal to log into |

### P2 — "Lars the Treasurer" · Chamber Manager (staff role: `manager`)

| Dimension | Detail |
|---|---|
| Role | SweCham Board Treasurer, part-time volunteer |
| Age / tenure | 58, 3 years on board |
| Tech literacy | Medium-low — expects dashboards, not tables |
| Locale | Swedish primary, fluent English |
| Typical day | Checks finance dashboard Monday mornings; attends monthly board meeting; signs off annual audit |
| Goals | (G1) See MRR / ARR at a glance. (G2) Confirm VAT is applied correctly before tax filing. (G3) Read-only oversight — no accidental edits. (G4) Export for auditor. |
| Pain points | (P1) No finance dashboard exists today (`/admin` is a roadmap placeholder). (P2) Must ask Khun Nok for any number. (P3) Worries about accidentally breaking data. |
| Motivations | Fiduciary duty; clean audit trail |
| JTBD | "When the board asks me 'how are we tracking vs last year?', show me the answer without me opening a spreadsheet." |
| Anti-goals | Doesn't want write access, doesn't want to be the "IT person" |

### P3 — "Anna" · Corporate Member Primary Contact (Premium tier, Partnership Platinum)

| Dimension | Detail |
|---|---|
| Role | Marketing Manager at a Swedish manufacturing firm (Bangkok office) |
| Age | 34, 2 years at SweCham |
| Tech literacy | High — uses HubSpot, LinkedIn Ads, Canva daily |
| Locale | English primary, reads Swedish, basic Thai |
| Typical use | Logs in 2–3 times/quarter to: submit E-Blast, RSVP to events, update company profile, retrieve invoice for finance |
| Goals | (G1) Get full value from Platinum (4 event tix, 10 E-Blasts, website banner). (G2) Pay online from her phone between meetings. (G3) Add her 2 co-contacts so they can RSVP without her. |
| Pain points | (P1) No benefit-usage visibility — never knows how many E-Blasts she has left. (P2) Current invoice receiving was PDF-by-email — now expects self-serve download. (P3) Can't pay online yet (F5 not shipped). (P4) Co-contacts (P5 below) can't self-register for events. |
| Motivations | Show her marketing director the sponsorship ROI; avoid quarterly chasing emails from admin |
| JTBD | "When I pay THB 150k/year for Platinum, show me in one screen what I've used, what's left, and what expires when — so I can defend the spend." |
| Anti-goals | Doesn't want to call admin; doesn't want 12 emails from the chamber |

### P4 — "Pim" · Corporate Member Secondary Contact (Partnership Platinum, not primary)

| Dimension | Detail |
|---|---|
| Role | Executive Assistant at same Swedish firm |
| Age | 28 |
| Tech literacy | Medium-high — scheduling power user |
| Locale | Thai primary, fluent English |
| Typical use | RSVPs to events on behalf of 3 colleagues; downloads invoices to submit to finance |
| Goals | (G1) Register colleagues for events without pinging Anna. (G2) Download invoice PDF in TH for Thai finance dept. (G3) Update her own profile (phone, LinkedIn). |
| Pain points | (P1) F3 invite-link flow limits her capabilities vs Anna — opaque to her what she can / can't do. (P2) Needs TH invoice PDF but isn't sure locale switch affects PDF language. (P3) No calendar (.ics) export on events (F6 not shipped). |
| Motivations | Look competent to her manager; save time |
| JTBD | "When I RSVP 3 colleagues to an event, confirm their tickets and tell me how many of our quota we've used." |
| Anti-goals | Doesn't want to see Anna's finance data; doesn't want to accidentally upgrade the tier |

### P5 — "Somsak" · Individual Member (Thai Alumni tier, age 29)

| Dimension | Detail |
|---|---|
| Role | Mid-career Thai professional, SKAT alumnus |
| Age | 29 — near the age-35 ceiling |
| Tech literacy | Medium — mobile-first, rarely opens laptop |
| Locale | Thai primary |
| Typical use | Pays THB 1k/year, attends 1–2 cultural events, occasional networking |
| Goals | (G1) Pay fast (PromptPay QR on phone). (G2) Know when he ages out (35). (G3) Get Thai receipt for tax. |
| Pain points | (P1) Current portal feels B2B — built for companies, not individuals. (P2) Unsure what Thai Alumni actually includes vs Individual tier (¼-page directory entry, 1 event ticket). (P3) Email from chamber mostly English. |
| Motivations | Networking, Swedish alumni community, cheap membership |
| JTBD | "When I pay my THB 1k, confirm the receipt in Thai to my phone in 30 seconds." |
| Anti-goals | Doesn't want desktop-only UI; doesn't want to be upsold to Corporate |

**Persona coverage gap (flagged for research)**: Partnership-only (Diamond / Gold buyer) is functionally Anna's persona — but sponsor-minded, not benefit-consumer-minded. Recommend a **P3b — "Sven the Sponsor"** interview track during F7/F9 research. Also missing: platform super-admin (ourselves) — add when F13 is specced.

---

## § 4 Journey Maps

Each journey is rated by confidence: ● Evidence (shipped + observable) / ◐ Design intent (specced, not shipped) / ○ Hypothesis (needs research).

### 4.1 Member Onboarding — invite → first login → profile complete → first benefit use

| Stage | 1. Invited | 2. Click invite link | 3. Set password | 4. First login | 5. See landing | 6. Complete profile | 7. Use first benefit |
|-------|------------|----------------------|-----------------|----------------|----------------|---------------------|----------------------|
| **Action** | Admin clicks "Invite" in `/admin/members/[id]` | Click link in email within TTL | Set 12-char password | Redirect to `/portal` | Sees dashboard roadmap card | Navigate `/portal/edit` | Discover "Benefits" menu |
| **Thought** | "Did admin really invite me?" | "Is this the right link?" | "Ugh, 12 chars" | "Where do I start?" | **"Why is this a roadmap?"** ◐ | "Is this everything they need?" | **"Where are my E-Blasts?"** ○ |
| **Emotion** | curious | cautious | mildly annoyed | expectant | confused (current UI) | dutiful | confused (no benefit page yet) |
| **Touchpoint** | Email (Resend) | Browser | Invite page | Auth flow | `/portal` | `/portal/edit` | (none — gap) |
| **Evidence** | ● shipped F1+F3 invite-link (branch 008) | ● | ● `§ 7.2` auto-focus | ● | ● `portal/page.tsx:48-79` — F-phase badges | ● | ○ **GAP — no benefits surface** |
| **Pain / Opportunity** | Bounce risk (no resend ≥ 60s in invite flow?) | OK | Password strength meter OK (`§ 11.4`) | OK | **Replace roadmap with first-time checklist** | Long form risk — split into 2 steps | Build smart #1 Benefit Dashboard |

### 4.2 Invoice Payment (F5) — current state: ◐ design intent

| Stage | 1. Receive invoice email | 2. Open portal | 3. View invoice | 4. Click Pay | 5. Stripe Element | 6. Confirm | 7. Receipt |
|-------|--------------------------|----------------|-----------------|--------------|-------------------|------------|------------|
| **Action** | Link in email | SSO / sign-in | `/portal/invoices/[id]` | Pay button | Enter card / PromptPay QR | 3DS / SCA step | Receipt PDF |
| **Thought** | "Is this legit?" | "Hope I remember my password" | "Does this have VAT?" | "Hope it's secure" | "Why another form?" | "Is it done?" | "Where's the Thai receipt?" |
| **Emotion** | suspicious → reassured | frustrated (password) | focused | anxious | anxious | anxious → relieved | satisfied IF receipt is fast |
| **Touchpoint** | Resend email | Auth | Portal | Payment intent modal | Stripe Elements iframe | Stripe | Email + Blob PDF |
| **Pain** | Phishing concern | Forgot password | No inline remaining-balance on partial pay | Pay button discovery | PromptPay QR on mobile vs card on desktop needs split UX | No pending state | Bilingual receipt timing |
| **Opportunity** | DMARC/DKIM trust badges; plain copy | **Magic link for invoices** (time-boxed token) | Show "what happens next" helper | Make Pay the primary button top-of-page | Auto-select PromptPay on mobile; card on desktop; remember choice | Skeleton while webhook races receipt write | **Show receipt inline AND email — don't make user hunt** |
| **Confidence** | ○ | ● | ● | ◐ | ◐ | ◐ | ◐ |

### 4.3 Membership Renewal

| Stage | 1. -60d reminder | 2. -30d reminder | 3. -14d reminder | 4. Review benefits | 5. Pay renewal | 6. Renewed state |
|-------|------------------|------------------|------------------|--------------------|----------------|-------------------|
| **Action** | Email | Email + in-portal banner | Email + phone call from admin | View benefit-usage + tier comparison | Journey 4.2 | Badge "Active through 2027" |
| **Thought** | "Already?" | "Should I upgrade/downgrade?" | "OK, time to act" | "Did I get my money's worth?" | — | "Was that worth it?" |
| **Pain** | ○ Too early feels spammy | Tier-comparison is hidden in PDF, not in portal | Personal touch is still manual | **No benefit-usage page = no defensible spend** | — | No tier-downgrade path in self-service |
| **Opportunity** | Smart reminder cadence (F8 smart #3) based on past-engagement score | Auto-upgrade suggestion card (smart #6 / #16) — "You used 12 E-Blasts last year. Consider Gold Partnership." | Admin-initiated "call list" auto-generated from at-risk | Ship Benefit Dashboard (smart #1) **before** F8 renewal reminders | See 4.2 | Send personalized "here's what you unlocked" email |
| **Confidence** | ○ all columns | | | ○ **critical** | ◐ | ○ |

### 4.4 Event Attendance (F6 — EventCreate integration)

| Stage | 1. Discover event | 2. Register | 3. Receive ticket | 4. Check-in | 5. Follow-up |
|-------|-------------------|-------------|-------------------|-------------|--------------|
| **Action** | Email / website / portal | Click through to EventCreate (external) | Email from EventCreate | QR at door | Thank-you email |
| **Thought** | "Do I get a discount?" | "Why another site?" | "Will it sync back?" | "Did my company's 4 tickets get used?" | "Another one next month?" |
| **Pain** | Discount rate is in tier doc, not surfaced per-event | **External redirect breaks portal context** (by design — `docs/event-integration-analysis.md`) | — | Partnership 4-ticket quota tracking invisible until F6 ships | No engagement signal back to benefit dashboard |
| **Opportunity** | Tier-aware price banner on event link ("You pay THB 1,200, member price THB 800") | Embed EventCreate via iframe in `/portal/events` where possible | Zapier webhook → sync ticket to portal | Live ticket counter in portal ("3 of 4 Platinum tickets used") | Engagement score bump + auto-update benefit usage |
| **Confidence** | ○ | ◐ (F6 planned) | ◐ | ◐ | ○ |

### 4.5 E-Blast Quota Consumption (F7)

| Stage | 1. Compose | 2. Preview | 3. Submit | 4. Admin approve | 5. Send | 6. Analytics |
|-------|------------|------------|-----------|------------------|---------|--------------|
| **Actor** | Anna (member) | Anna | Anna | Khun Nok | Resend Broadcasts | Anna |
| **Action** | `/portal/eblast/new` | HTML preview | Submit for review | Approve / request changes | Broadcast fires | Opens / clicks |
| **Thought** | "Will this look right to recipients?" | "Is the Thai translation right?" | "When does it actually go out?" | "Is this on-brand? On-policy?" | — | "Was it worth the quota?" |
| **Pain** | Editor discoverability; no templates | No mobile/desktop preview toggle | No clear SLA | Policy drift across admins | Send failures opaque | **No benefit-usage link back** |
| **Opportunity** | Starter templates per tier | EN/TH side-by-side preview | Show expected send time (next batch window) | Admin checklist (spam-filter rules, unsubscribe block) | Delivery-state banner (ties to `ux-standards § 4.4`) | Consume 1 of N quota; surface in Benefit Dashboard |
| **Confidence** | ◐ `docs/email-broadcast-analysis.md` | ◐ | ○ | ○ | ◐ | ○ |

### 4.6 Member Self-Service Tier Upgrade

| Stage | 1. See suggestion | 2. Review tiers | 3. Confirm upgrade | 4. Pay delta | 5. New benefits active |
|-------|-------------------|----------------|--------------------|--------------|--------------------------|
| **Thought** | "Why are they suggesting this?" | "What exactly do I gain?" | "Is the upgrade pro-rated?" | "How much more THIS year?" | "When does my E-Blast quota update?" |
| **Pain** | No auto-suggestion yet (smart #16) | Comparison table lives in a PDF | Ambiguous pro-rate math | VAT on delta? | Quota math on upgrade (6 → 15 E-Blasts mid-year) |
| **Opportunity** | Engagement-score-driven card | In-portal tier comparator | Show the math explicitly (days remaining × rate) | Stripe partial charge | Quota recompute + celebratory toast |
| **Confidence** | ○ all stages |

### 4.7 Admin Intervention on At-Risk Member

| Stage | 1. See alert | 2. Diagnose | 3. Pick action | 4. Execute | 5. Track outcome |
|-------|--------------|-------------|----------------|------------|-------------------|
| **Action (Khun Nok)** | Dashboard card "3 at-risk" | Click → member list with risk score + reason | Call / email / in-portal nudge | Log action on timeline | See resolution on timeline |
| **Pain** | No dashboard card exists (F9 scope) | No risk score yet (F8 smart #2) | Multi-channel; scattered | Timeline supports manual note only | No outcome tracking |
| **Opportunity** | Ship v0 at-risk card early (last_activity_at is already captured in F3) | Risk reason: "No events in 180d", "No E-Blasts used", "Overdue invoice" | Template per reason | One-click log | Close-the-loop notification at 30d |
| **Confidence** | ○ | ◐ (last_activity_at exists) | ○ | ● timeline exists | ○ |

---

## § 5 Gap Analysis & Opportunity Matrix

Mapping each opportunity by **User Impact** × **Effort** (effort estimated from feature spec complexity and F-phase dependencies).

```
HIGH IMPACT
    │
    │  [A] Benefit Usage          [B] F5 Online Payment
    │      Dashboard (smart #1)       (in flight, branch 009)
    │
    │  [C] At-Risk Admin Card     [D] Member Portal Landing
    │      (v0 using              fix (remove F-phase
    │      last_activity_at)         roadmap badges)
    │
    │  [E] Benefit-comparison     [F] Tier Upgrade Self-
    │      on tier upgrade            service with pro-rate
    │
    │  [G] Finance KPI tiles      [H] Bulk invoice actions
    │      for Lars (manager)
    │                             [I] Credit-note nav entry
    │
    │  [J] First-time onboarding  [K] Keyboard shortcut (?)
    │      checklist                  help dialog
    │
    │  [L] EventCreate ticket-    [M] "Download my data"
    │      quota sync (F6)            GDPR self-serve
    │
LOW IMPACT
    ├──────────────────────────────────────────────▶
    LOW EFFORT                        HIGH EFFORT
```

**Quadrants**:
- **Quick wins (high impact, low effort)**: D, I, K, G (v0), M (stub). Ship in 1–2 sprints.
- **Strategic bets (high impact, high effort)**: A, B, F, L. Already sequenced in F5/F6/F8/F9. Don't accelerate L without validating iframe path.
- **Table-stakes (low impact, low effort)**: H (bulk invoice). Batch with F4 polish.
- **Defer (low impact, high effort)**: density modes beyond default (already parked to F2+).

---

## § 6 Top-10 Prioritised Roadmap Recommendations

Ranked by **(user value) × (confidence)** ÷ **(effort)**. Time horizon from the user's chair, not the implementer's.

| # | Recommendation | Horizon | Why (user value) | Confidence |
|---|----------------|---------|------------------|------------|
| 1 | **Replace `/portal` landing roadmap card** with (a) next-action checklist, (b) invoice-due summary (already shipped — keep), (c) benefit-usage teaser. Drop `F4/F5/F6` literal badges. | **Short** (≤2 weeks) | Members land on a system that looks ready-for-them, not an internal phase plan. Removes the #1 "unfinished software" signal. | High — code evidence at `portal/page.tsx:48-79` |
| 2 | **Ship F5 Online Payment MVP** (branch 009 already in flight — Stripe Elements + PromptPay). Make Pay the primary CTA on `/portal/invoices/[id]`, auto-select PromptPay on mobile. | **Short** (in-progress) | Unblocks member self-service renewal — the single biggest admin-time saver. | High — spec exists |
| 3 | **Staff finance KPI tiles for `/admin`** — Active members · Invoices due this week · Overdue · MRR YTD. Gate behind `role === 'manager' \|\| role === 'admin'`. | **Short** | Gives Lars (manager persona) a reason to log in. Uses data already in F3/F4. | High — data already exists |
| 4 | **Benefit Usage Dashboard v0** (smart #1) — per-member `/portal/benefits` and `/admin/members/[id]/benefits`. Start with E-Blast count + cultural-ticket count + directory listing state. | **Medium** (4–6 weeks, after F5) | Defends the renewal spend; reduces "did I get value?" disputes. Competitive moat vs GlueUp. | High — design in `smart-chamber-features.md` § 2 |
| 5 | **At-risk member v0 card on `/admin`** — list members with `last_activity_at > 120d` + unpaid invoice. | **Short** (1 sprint) | Preview of F8; exploits F3 data already captured; Khun Nok persona G2+G3. | High — `last_activity_at` trigger shipped |
| 6 | **Credit-notes nav entry + Finance subgroup** — Group Invoices + Credit Notes + Settings/Invoicing under a "Finance" section; prepare Settings to absorb Payments (F5) + Branding (F12). | **Short** (≤1 week) | Findability; IA scales to F5–F9 without a flat 15-item sidebar. | High — nav file is 203 LOC |
| 7 | **First-time onboarding checklist** on `/portal` (dismissible card): complete profile · invite co-contacts · view benefits · download first invoice. | **Short** | Anna + Pim onboarding journey (§ 4.1) currently drops users on a blank dashboard. | Medium — needs copy-testing |
| 8 | **Resend affordance on F5 payment-receipt email** — apply `ux-standards.md § 4.4` to the new receipt path in `src/app/api/payments/` + `src/app/api/webhooks/stripe/`. | **Short** (fold into F5) | Consistency + deliverability safety net for the money path. | High — precedent in F1/F4 |
| 9 | **GDPR "Download my data" stub** on `/portal/account` — even if it just emails admin, it closes PDPA/GDPR SAR risk during the window before F9 ships the full export. | **Short** | Legal risk reduction; low user touch but high audit value. | Medium |
| 10 | **Keyboard shortcut help dialog (`?`)** — enumerate ⌘K, Esc, Alt+U, form Enter; list per-route shortcuts. | **Medium** | Promised by `ux-standards.md § 7.4`; expected by Anna's tech-literate persona. | High — small spec |

**Long-horizon watchlist (F9+)**: tier-upgrade self-service (smart #16), EventCreate quota sync (F6), E-Blast analytics loop, directory e-book generator, engagement score.

---

## § 7 Research Methods to Run Next

Given the audit is expert-review-only, the highest-value next step is **validating personas and journeys with real users** before F5 ships its final UX. Proposed plan below keeps budget tight (2 researchers, ~2 weeks).

### 7.1 Recommended study plan

| Study | Method | N | Segment | Duration | Output |
|-------|--------|---|---------|----------|--------|
| **S1 — Member generative** | Semi-structured interview, remote (Zoom) | 8 members (2 Premium, 2 Platinum, 2 Regular, 2 Thai Alumni) + 2 primary / 6 secondary contact mix | Mixed tiers + contact roles (TH + SV + EN) | 45 min each | Validated personas P3 / P4 / P5; JTBD list; benefit-value narratives |
| **S2 — Admin shadowing** | Contextual inquiry, on-site or screen-share | 2 admins + 1 treasurer (Lars) | Staff + Manager | 90 min | Validated P1 / P2; task-time baseline for Excel workflows; pain ranking |
| **S3 — F5 Payment usability** | Moderated usability test on staging | 6 members | Mix of phone + laptop | 30 min | SEQ ≥ 6/7 on Pay task; error rate < 10%; PromptPay vs card preference data |
| **S4 — Invoice PDF comprehension** | 5-second test + survey | 30 members | Bilingual (TH + EN) | asynchronous | Do TH + EN layouts both scan correctly? Does VAT break out? |
| **S5 — Benefit-dashboard concept test** | Unmoderated (Maze / Lookback) on Figma prototype | 20 members | All tiers | async, 10 min | MaxDiff on benefit surfaces; task completion on "how many E-Blasts left?" |

### 7.2 Interview guide (starter — S1 generative)

Open (5 min): "Thanks for joining. I'd like to understand how you actually use your SweCham membership — there are no right answers, I'm here to learn from you."

Warm-up (5 min): tell me about your company + role, how long with SweCham, how you first joined.

Core (30 min, semi-structured):
1. Walk me through the **last three times** you interacted with SweCham (any channel). What happened? What were you trying to accomplish?
2. When you think about your membership, what do you actually **pay for**? (Probe: can you name specific benefits?)
3. The last time you paid an invoice — tell me how that went. (Probe: channel, pain, confusion, time.)
4. If I gave you a magic wand for the portal, what's the **one thing** you'd change? (Silent probe — don't suggest.)
5. How do you find out about SweCham events? What decides if you'll go?
6. (For Platinum/Diamond only) Your firm pays THB 150k+/year — how do you defend that to your boss? What evidence do you use?
7. Show me your inbox / last three SweCham emails. What did you do with them?

Close (5 min): anything you expected me to ask? Can we contact you for a follow-up usability test in 4 weeks?

**Anti-leading checks**:
- Never "how useful is X?" → instead "tell me about your experience with X"
- Never prompt "do you like the benefit dashboard?" — it doesn't exist; use concept tests (S5)
- Observe behaviour > self-report on channel preference (S2, S3)

### 7.3 Success criteria to measure post-S3 (F5 usability)

- **Task completion** ≥ 90% unassisted on "Pay an open invoice on your phone"
- **SEQ** median ≥ 6/7 on that task
- **Time-to-first-pay** < 2 min from invoice email → receipt
- **SUS** ≥ 72 on portal overall (industry average is 68)
- **Error rate** < 10% (defined as back-button use, incorrect tier selection, failed payment requiring retry)

### 7.4 Recruitment & ethics notes

- Use existing member database; offer THB 500 voucher for S1 / S3 (≤1% of annual fee, PDPA-defensible non-coercive).
- Consent form covers (a) recording, (b) PII handling, (c) 90-day retention then destroy, (d) right to withdraw. Aligns with PDPA § 28 + GDPR Art 7.
- TH-speaking moderator for Thai Alumni + Thai secondary contacts; SV-capable moderator for at least 2 Swedish members.
- Sessions **not** linked to billing data — P5 persona especially sensitive (age near 35 ceiling could be read as discriminatory).

---

## Limitations of this audit

- **No live users observed** — all findings above are expert review + document synthesis. Confidence markers reflect this; journeys 4.3–4.7 contain hypotheses that MUST be validated by S1/S2 before being baked into specs.
- **Screenshots not inspected** — code + doc review only. Pixel-level issues (CLS, actual focus-ring contrast in dark mode, Thai line-height with Sarabun) need visual QA (see `docs/qa/` for existing assets).
- **Sample of routes reviewed**: `/admin`, `/portal`, nav config, page-header, staff-sidebar, invoice + member detail paths. Did NOT inspect: `/admin/credit-notes/[id]`, `/portal/contacts/invite`, email templates, PDF renders. Follow-up pass after F5 ships.
- **No benchmark data** — GlueUp / Wild Apricot / MemberClicks comparison is from `smart-chamber-features.md § 1` (internal claim), not validated by competitive teardown.
- Staff + manager KPI assumptions (§ 6 #3) based on industry patterns, not SweCham board interviews — validate in S2.

---

*Authored by Chamber-OS UX Researcher · 2026-04-24. Update after each feature ship + re-run heuristics when F5 / F6 / F9 land.*
