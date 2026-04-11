# Feature Specification: F2 — Membership Plans

**Feature Branch**: `002-membership-plans`
**Created**: 2026-04-11
**Status**: Draft
**Input**: User description: "F2 Membership Plans — Full scope. Multi-tenant aware plan catalogue with per-tenant fee config, year versioning, full CRUD admin UI, inline edit, bulk actions, command palette, SV/EN/TH i18n, and 9-row SweCham 2026 seed. See docs/membership-benefits-analysis.md, docs/saas-architecture.md, docs/smart-chamber-features.md. Questions Q1–Q5 in membership-benefits-analysis.md §5 must be resolved at /speckit.clarify."

## Clarifications

### Session 2026-04-11

- Q: How should a plan's applicability to a company vs an individual person be modelled in the data layer (resolves `docs/membership-benefits-analysis.md` §5 Q2 for F2 scope)? → A: Explicit `member_type_scope` enum with values `company`, `individual`, `both` on every plan. Individual and Thai Alumni plans are `individual`; Premium / Large / Regular / Start-up / Diamond / Platinum / Gold are `company`. No plan uses `both` today, but the enum leaves room for it without migration. F3 signup flow branches on this flag rather than inferring scope from unrelated benefit fields such as `max_member_age`.
- Q: Is the tenant-context resolver introduced as cross-cutting infrastructure in F2, or deferred to F10 multi-tenant onboarding? → A: Introduced fully in F2. F2 delivers (a) a tenant-context resolver middleware active on every request touching tenant-scoped data, (b) database-layer row-level isolation policies on every tenant-scoped table, and (c) an automated integration test that creates two tenants and exercises cross-tenant reads and writes from both directions, asserting zero visibility — satisfying Constitution v1.4.0 Principle I clauses 1, 2, and 3 on day one. No Complexity Tracking deviation required.
- Q: How is a plan's localised display name stored on the plan record? → A: Structured locale map `{ en, th, sv }` as a single field per plan. English is required (validation blocks save if missing), Thai and Swedish are optional but surfaced with a visible "missing translation" indicator in admin views until filled. Downstream rendering picks the active locale with a fallback chain `active → en`. A future locale (e.g., `ja`, `de`) is added by extending the map without schema migration. This pattern is used consistently for every future tenant-editable localised text field on the platform.
- Q: What is the edit policy for a plan belonging to a previous year (year < current calendar year)? → A: **Partial lock** — cosmetic fields remain editable; pricing and eligibility fields are locked. Editable on a prior-year plan: display name (all locales), description (all locales), sort order, active flag, soft-delete / undelete. Locked on a prior-year plan: annual fee, registration-fee override, minimum/maximum turnover, maximum duration, maximum member age, benefit matrix fields, member-type scope, and the partnership-includes-corporate link. Validation MUST block save attempts on locked fields with a clear error that names the field and the rule; the edit form MUST display a persistent banner explaining the lock. Admins who need to correct a locked field must clone the plan to the current year and correct it there. The cloned plan becomes the source of truth for new member signups while the historical plan remains intact for invoice reprints and audit.
- Q: How are monetary amounts stored on plan and fee-config rows so the schema survives the first non-Thailand tenant without a migration? → A: Money is stored as **integer minor units per field** plus a **single authoritative currency code on `tenant_fee_config`**. `amount_minor_units` is in the currency's smallest unit (satang for THB, yen for JPY, öre for SEK, cents for EUR) — 36,000 THB = `3_600_000`. VAT calculations operate in integers to avoid rounding drift and match Constitution Principle IV (Payment Security — precise integer maths, no floats in money). **Per-plan `currency_code` is deliberately NOT stored** — all plans within a tenant share the tenant's default currency (YAGNI per critique P3, 2026-04-11). A future tenant with a mixed-currency catalogue requirement can retrofit per-plan `currency_code` columns with a straightforward additive migration; no tenant on the forecast roadmap needs this today. First non-Thailand tenant requires only a different value in `tenant_fee_config.currency_code`, no schema change.
- Q (critique 2026-04-11): Is per-plan currency needed for F2? → A: **No** (resolves critique P3). Simplify to one currency per tenant via `tenant_fee_config.currency_code`. Re-introduce per-plan currency if and when a tenant with a mixed-currency catalogue actually onboards.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Admin views the annual membership plan catalogue (Priority: P1)

A chamber admin needs to see, at a glance, every membership plan the chamber offers for the current year — its name, category (corporate vs partnership), annual fee, active/inactive state, and an indication of what benefits it grants. The catalogue is the source of truth for what the chamber sells; without it, every downstream feature (member signup, invoicing, renewal, benefit tracking) has no price or benefit data to work against.

**Why this priority**: The plan catalogue is the **foundation layer** for F3–F9. An admin cannot onboard a single member (F3) or issue a single invoice (F4) until plans exist. Seeding and displaying the 9 SweCham 2026 plans is therefore the MVP — even if nothing else ships, an admin who can see the live catalogue has an answer to "what does membership cost?" and downstream features have data to build on.

**Independent Test**: Seed the 9 SweCham 2026 plans into a freshly-deployed tenant database, sign in as an admin, navigate to the Plans section, and verify the list shows exactly 9 rows (6 corporate + 3 partnership) with correct names, annual fees in THB, active state, and year. No edit, no create, no other feature required.

**Acceptance Scenarios**:

1. **Given** a SweCham tenant with 9 seeded 2026 plans and an admin signed in, **When** the admin opens the Plans list, **Then** all 9 plans appear with correct annual fees (36,000 / 26,000 / 16,000 / 10,000 / 6,000 / 1,000 THB for corporate tiers; 200,000 / 150,000 / 100,000 THB for partnership), correct category badge (corporate or partnership), and correct active/inactive state.
2. **Given** the admin is viewing the Plans list, **When** they filter by category = "partnership", **Then** only the 3 partnership plans are shown.
3. **Given** the admin is viewing the Plans list, **When** they filter by year = 2026, **Then** only 2026 plans are shown; switching to 2027 shows an empty state until 2027 plans exist.
4. **Given** the admin is on a slow network, **When** the Plans list is loading, **Then** a shimmer skeleton placeholder is rendered in the exact shape of the final table so layout does not jump.
5. **Given** a member (non-admin) signs in, **When** they attempt to open the Plans admin page by typing the URL, **Then** they are denied access and redirected away.
6. **Given** the admin switches the UI language between English, Thai, and Swedish, **When** viewing the Plans list, **Then** every column header, button, filter label, status, and empty-state message renders in the chosen language; plan display names also appear in the chosen language because plan names are stored as translated content per tenant.

---

### User Story 2 — Admin creates a new membership plan for a new year (Priority: P1)

Each year the chamber publishes a new membership package. The fastest path to next year's catalogue is to duplicate the current year's plans, change the year label, tweak prices or benefits, and activate them. Without this capability, the chamber rewrites the catalogue from scratch every 12 months.

**Why this priority**: Year versioning is what differentiates a real membership system from a static price list. Without it, the chamber either (a) loses history (overwrites 2026 fees and breaks historical invoice reprints) or (b) manually duplicates rows in the database. Both are unacceptable — the former violates audit integrity, the latter requires developer involvement every year. This must ship with F2.

**Independent Test**: Sign in as admin, click "Clone 2026 → 2027" on the Plans list, confirm the dialog, and verify that 9 new plans appear tagged as 2027 with the same benefit structure and fees as 2026, in draft (inactive) state by default so they can be reviewed before exposure.

**Acceptance Scenarios**:

1. **Given** the admin is on the 2026 Plans list, **When** they trigger "Clone 2026 → 2027", **Then** 9 plans with year = 2027 are created with identical benefit data and fees, all starting in the inactive state, and the admin lands on the filtered 2027 view ready to edit.
2. **Given** 2027 plans already exist, **When** the admin triggers "Clone 2026 → 2027" again, **Then** the system refuses with a clear message and offers to open the existing 2027 list instead — duplicate-year cloning is blocked to prevent silent data duplication.
3. **Given** the admin is editing a cloned 2027 Premium Corporate plan, **When** they change the annual fee from 36,000 to 38,000 THB and save, **Then** the 2026 Premium row is untouched and historical 2026 invoices continue to reference the original 36,000 price.
4. **Given** the admin is creating a brand-new plan from scratch (not a clone), **When** they step through the create wizard (basics → fees → benefits → review), **Then** each step validates its own fields and the final "Save" only succeeds if all required fields are present and the name is unique within tenant+year.
5. **Given** the admin activates a 2027 plan, **When** the activation is confirmed, **Then** that plan becomes visible to downstream F3 member signup while 2026 plans remain valid for existing members already on them.

---

### User Story 3 — Admin edits plan details, fees, and benefits (Priority: P1)

Plans evolve during the year: a benefit is corrected, a fee is adjusted, a typo in a plan name is fixed. The admin must be able to open a plan, change any field, and save — with the change captured in the audit trail so the chamber can always explain "why does this invoice reference 35,500 THB when today's catalogue says 36,000?"

**Why this priority**: Editing is inseparable from creation — if admin cannot fix their own typos without developer help, adoption fails on day one. Equal priority with US1 and US2.

**Independent Test**: Create or seed a plan, sign in as admin, open the plan's edit view, change the plan name, annual fee, and one benefit value, save, reload the list, and verify the changes are persisted, localised, and recorded in the audit log with the previous and new values.

**Acceptance Scenarios**:

1. **Given** a seeded Premium Corporate plan, **When** the admin edits the annual fee and saves, **Then** the list reflects the new fee, the audit trail records `plan_updated` with a before/after diff including actor, timestamp, and field-level changes.
2. **Given** a plan belongs to a previous calendar year, **When** the admin attempts to change the annual fee (or any other locked field per FR-014), **Then** validation rejects the change with a field-named error, the banner is shown explaining the partial lock, and the admin is offered a one-click path to clone the plan into the current year and edit the clone. Attempting the same change via inline edit or bulk action is rejected with the same rule.
3. **Given** the admin is filling the edit form, **When** they leave a mandatory translated name field empty in any of the three locales, **Then** validation blocks save and highlights the missing field in the offending locale tab.
4. **Given** the admin is editing a partnership plan, **When** they change the "includes Premium Corporate" toggle, **Then** a clear explanatory note surfaces in the review step warning that downstream benefit inheritance logic depends on this flag and member invoices already issued for the plan will not retroactively change.

---

### User Story 4 — Admin deactivates a plan and soft-deletes obsolete plans (Priority: P2)

Plans get retired when a tier is phased out — but the chamber must keep the historical record so last year's invoices still resolve their plan reference. Deactivation hides a plan from the member signup flow while preserving it for historical read access; soft-delete removes it from admin UI lists but still preserves it in the database for audit and historical invoice reprints.

**Why this priority**: P2 rather than P1 because for the F2 ship, seed data is fresh and no plans need retirement on day one. The capability is required before F3 member signup launches so that "inactive" has meaning, but it can land in the same release window without blocking MVP sign-off.

**Independent Test**: Create a test plan, deactivate it, verify it disappears from the F3 signup flow (when F3 exists; simulated via a read-only integration test of the "active plans only" query), then soft-delete it and confirm it vanishes from the admin default list but reappears under a "Show deleted" toggle.

**Acceptance Scenarios**:

1. **Given** an active plan, **When** the admin toggles it to inactive and confirms the dialog, **Then** the plan is hidden from future member signups but remains visible in admin lists with an "Inactive" badge.
2. **Given** an inactive plan with zero members attached, **When** the admin soft-deletes it, **Then** the plan is removed from the default list, remains in the database with a deletion timestamp, and an audit entry records the delete.
3. **Given** an inactive plan that still has at least one active member attached (future F3 state), **When** the admin attempts to soft-delete it, **Then** the system refuses with a message listing affected members and offering to open the member list instead.
4. **Given** a soft-deleted plan, **When** the admin enables "Show deleted" in the list, **Then** deleted plans appear with a subdued style and an "Undelete" action that restores them.

---

### User Story 5 — Admin configures per-tenant fee defaults (Priority: P2)

VAT rate, default currency, and registration fee are **per-tenant** because different chambers operate under different tax regimes. SweCham needs Thailand's 7% VAT and a 1,000 THB registration fee; a future tenant in another country may need a different rate, currency, or no registration fee at all. An admin must be able to see and edit these defaults from the platform settings without a developer deploying a code change.

**Why this priority**: P2 because the SweCham seed can hardcode 7% + 1,000 THB + THB on day one; editing the defaults is only required before the second tenant onboards. However, the **data model and tenant scoping** must be in place for F2 so the per-tenant column is not retrofitted later. UI is optional-MVP; schema + seed + read-only display is mandatory-MVP.

**Independent Test**: Sign in as admin, open the fee-config settings page, confirm the values (currency = THB, VAT = 7%, registration fee = 1,000 THB) are displayed with the correct locale formatting, change the VAT rate, save, and verify the audit log records the change.

**Acceptance Scenarios**:

1. **Given** a fresh SweCham tenant, **When** the admin opens the fee-config page, **Then** currency THB, VAT 7%, registration fee 1,000 THB are displayed as the chamber's defaults.
2. **Given** the admin edits the VAT rate to 7.5% and saves, **When** the save completes, **Then** the new rate takes effect for subsequent plan displays (the plan list's derived "Total with VAT" preview uses the new rate), the old rate is captured in the audit log, and an informational note warns that historical invoices are not retroactively updated (invoice VAT is frozen in F4 at issuance time).
3. **Given** a manager role user signs in, **When** they open the fee-config page, **Then** they can read the values but all edit controls are hidden or disabled — only admin can change fee configuration.

---

### User Story 6 — Admin uses the command palette to find and act on plans instantly (Priority: P2)

A seasoned admin managing dozens of operations per hour must not have to click through menus to open a specific plan or trigger a common action. A universal command palette (⌘K / Ctrl+K) lets the admin jump straight to any plan by name, run "Create plan", or run "Clone 2026 plans to 2027" from anywhere in the app.

**Why this priority**: P2 because plans can be managed without it; however, launching the palette as part of F2 establishes the platform-wide pattern used by every downstream feature, and the cost of adding it now (when the only entity type is `plan`) is dramatically lower than retrofitting later when members, invoices, events, and broadcasts also need to be searchable.

**Independent Test**: Sign in as admin, press ⌘K (or Ctrl+K on Windows/Linux), type part of a plan name (e.g., "plat"), verify the partnership plan "Platinum" appears in results, press Enter, and confirm navigation to that plan's edit view. Press ⌘K again, type "clone", confirm the "Clone 2026 → 2027" action appears, and verify it runs the same flow as the list-view button.

**Acceptance Scenarios**:

1. **Given** the admin is anywhere in the admin portal, **When** they press ⌘K (Mac) or Ctrl+K (Windows/Linux), **Then** a palette overlay opens focused on a search input and closing it with Esc returns focus to the previously-active element.
2. **Given** the palette is open, **When** the admin types three or more characters, **Then** matching plans and actions appear grouped (Plans / Actions / Navigate), keyboard up/down arrows move selection, Enter selects.
3. **Given** a non-admin opens the palette, **When** it renders, **Then** admin-only actions such as "Create plan", "Clone plans to next year", and "Delete plan" do not appear.
4. **Given** the admin has reduced-motion enabled, **When** the palette opens, **Then** the open/close animation is removed or shortened per accessibility guidelines.

---

### User Story 7 — Admin edits plan fields inline from the list and runs bulk actions (Priority: P3 — **DEFERRED to F3**)

**Status (2026-04-11 critique X1c)**: Deferred to F3 Members & Contacts. The value math on ≤9 plan rows is thin (palette searches items already visible in the list below; bulk actions on 3–5 rows are not a throughput win), and the editable-table primitive deserves proper API design time under F3 where hundreds of member rows immediately stress-test it. The `cmdk`-based Command Palette stays in F2 (US6) because it provides genuine keyboard-accelerator value across every admin page regardless of row count. F3 will introduce `@tanstack/react-table` + the full inline-edit + bulk-action pattern, then retro-apply it to the Plans list if desired.

*(User story text retained below for traceability — DO NOT IMPLEMENT in F2.)*

For high-frequency edits (activate/deactivate five plans, nudge fees by 3%, rename plans), the admin should be able to edit directly in the list row without opening a modal, select multiple rows, and apply a change to all of them in one pass with an undo grace period.

**Acceptance Scenarios (deferred)**:

1. **Given** a row in the Plans list, **When** the admin clicks the annual fee cell, **Then** the cell becomes editable inline, Tab commits and moves to the next editable cell, Esc cancels.
2. **Given** the admin commits an inline edit, **When** the change is being saved, **Then** the UI reflects the new value optimistically with a subtle pending indicator; if the save fails, the value reverts and a toast explains the error.
3. **Given** the admin selects 3 rows via checkboxes, **When** they click "Deactivate selected" and confirm, **Then** all 3 plans flip to inactive in a single operation, a toast shows "3 plans deactivated · Undo", and Undo within 10 seconds reverts all 3 atomically.
4. **Given** the admin has reduced-motion or screen-reader settings enabled, **When** they use inline edit, **Then** changes are announced via an aria-live region and keyboard navigation (Tab, Shift+Tab, Enter, Esc) covers every interactive element.

---

### Edge Cases

- **Concurrent edits by two admins** on the same plan — last-write-wins with a non-blocking toast telling the overwritten admin their change was replaced and by whom; no hard conflict resolution UI in F2.
- **Partial seeding failure** — if the SweCham 2026 seed script fails mid-way (e.g., row 5 of 9 errors), the script MUST roll back all inserts in one transaction and leave the tenant in a clean pre-seed state.
- **Seed script re-run** — the seed script runs in two independent idempotent stages (per critique P4, 2026-04-11): **Stage A** upserts the `tenant_fee_config` row if missing (idempotent — safe to re-run at any time); **Stage B** inserts the 9 plans for `(tenant, 2026)` only if zero plans currently exist for that key, else refuses the whole plan batch with a non-zero exit. A partial-seeded state (fee_config exists but no plans, or vice versa) is handled cleanly — re-running seeds only the missing stage. Each stage is wrapped in its own transaction.
- **Previous-year plan editing** — covered by Clarifications Q4 + FR-014 (partial lock). Moved to the main user story AS for US3.
- **Cross-tenant probe** — see FR-005 + FR-026 for the full probe-handling contract. Summary: the admin receives a not-found response (never a forbidden response — existence is not leaked), the request path logs a `plan_not_found` info-severity audit event, and a separate F13 periodic super-admin scan correlates and escalates cross-tenant matches to `plan_cross_tenant_probe` at high severity per Constitution v1.4.0 Principle I clause 4 and critique E6.
- **Editing a plan from a previous year** — the edit form displays a persistent banner and enforces the partial lock defined in FR-014 and Clarifications Q4 (cosmetic fields editable, pricing + eligibility + benefits locked). An admin who needs to change a locked field is prompted to clone the plan into the current year and edit the clone. When F4 (Invoicing) ships, its "freeze at issuance time" rule is additive on top of this F2 lock.
- **Inactive plan with active members** — deactivating is allowed (new signups are blocked), but soft-deleting is refused; the admin is shown the list of attached members and must migrate them first.
- **Cloning a year with zero plans** — clicking "Clone 2026 → 2027" when 2026 has 0 active plans surfaces a clear empty-state message and refuses to create empty rows.
- **Locale fallback** — if a plan name is missing a Swedish or Thai translation, the list renders the English name with a subtle "missing translation" indicator for admin; the app does not show a raw key or blank cell.
- **VAT rate change mid-year** — changing VAT from 7% to 7.5% applies to future displays only; plan data itself does not store VAT. The tenant fee-config edit shows an explicit banner reminding the admin that historical F4 invoices are not retroactively recalculated.
- **Currency code change after plans exist is NOT supported in F2** (critique R1, 2026-04-11). Because money values are stored as integer `*_minor_units` that derive their decimal-place meaning from `tenant_fee_config.currency_code`, changing the currency code after plans exist would silently re-interpret every plan's stored integer — e.g. switching THB (2 decimals) → JPY (0 decimals) would reinterpret `3_600_000` from 36,000 THB to 3,600,000 JPY, a ~100× silent mispricing. F2 therefore **blocks `currency_code` changes on `PATCH /api/fee-config` when any non-deleted plan exists for the tenant** and returns `422 currency_code_immutable_in_f2` with the plan count + a pointer to the "delete all plans first, then change currency, then rebuild" workflow. Proper currency migration with FX-rate-aware revaluation is an F10 multi-tenant onboarding concern.
- ~~**Very large paste into an inline-edit numeric cell**~~ *(deferred to F3 with US7)* — server-side validation still rejects out-of-range values on the standard edit form (0 ≤ annual fee ≤ 10,000,000).
- **Browser refresh during an in-flight mutation** — the next page load reflects the true database state. Applies to every save from the standard edit form (US3).
- **Keyboard-only admin** — every interaction (create, edit, clone, deactivate, delete, palette, inline edit, bulk select) is reachable via keyboard without a mouse; focus rings are visible.

## Requirements *(mandatory)*

### Functional Requirements

**Catalogue read & display**

- **FR-001**: System MUST display a filterable, sortable list of all membership plans belonging to the currently-resolved tenant, including plan name, category (corporate | partnership), annual fee, year, active state, and last-updated timestamp.
- **FR-002**: System MUST provide category, year, and active-state filters on the Plans list and a free-text search on plan name.
- **FR-003**: System MUST render loading states with shimmer skeleton placeholders in the exact shape of the final table per the project UX standards, never with a blank screen or a blocking spinner.
- **FR-004**: System MUST localise every user-facing string — including plan display names — in English, Thai, and Swedish. For static UI copy, missing English is a build-breaker and missing Thai or Swedish falls back to English with a CI warning. For tenant-editable plan display names, the name is stored per plan as a structured locale map with keys `en`, `th`, and `sv`; `en` is required and validation MUST block save if missing, while `th` and `sv` are optional on save but surfaced with a visible "missing translation" indicator in admin views until filled. Rendering picks the active locale with a fallback chain `active → en`, and future tenant locales (e.g., `ja`, `de`) MUST be addable to the map without schema migration.
- **FR-005**: System MUST scope every plan read, write, and side effect by tenant such that no admin of Tenant A can read, create, update, or delete a plan belonging to Tenant B — enforced at BOTH the application layer and the database layer per Constitution v1.4.0 Principle I (defence in depth). F2 MUST deliver this as a single coherent piece of work: a tenant-context resolver active on every request touching tenant-scoped data, database-layer row-level isolation policies on every tenant-scoped table introduced by F2 (plans and tenant fee configuration), and an automated integration test that creates two tenants and asserts zero cross-tenant visibility in both read and write directions. A Tenant A admin probing a Tenant B plan identifier MUST receive a not-found response (never a forbidden response — existence MUST NOT be leaked). The request path MUST log every admin 404 as a `plan_not_found` **info-severity** audit event carrying the requested plan identifier + actor + method + route; request-path code MUST NOT run a `BYPASS RLS` query to detect cross-tenant hits (critique E6). A separate periodic super-admin scan (future F13) correlates `plan_not_found` events across tenants and escalates matches to a `plan_cross_tenant_probe` **high-severity** security event.

**Create, update, clone, deactivate, delete**

- **FR-006**: Admin users MUST be able to create a new plan via a multi-step wizard (basics → fees → benefits → review) with per-step validation; the Save action MUST be disabled until all mandatory fields pass validation.
- **FR-007**: Admin users MUST be able to edit every field of an existing plan and save the change, with before/after values captured in the audit log.
- **FR-008**: Admin users MUST be able to clone all active plans for a given year into a new year with one action; the clone action MUST refuse if any plan already exists for the target year.
- **FR-009**: Admin users MUST be able to toggle a plan's active state with a confirmation dialog; inactive plans MUST NOT be selectable in the (future) F3 member signup flow but MUST still be readable for historical reference.
- **FR-010**: Admin users MUST be able to soft-delete a plan only when it has zero active member attachments; hard-delete MUST NOT exist in F2 for audit compliance.
- **FR-011**: System MUST expose an "Undelete" action for soft-deleted plans and a "Show deleted" toggle on the list view.

**Year versioning**

- **FR-012**: Plans MUST carry an explicit year attribute; two plans with the same internal identifier can coexist across different years (e.g., `premium` 2026 and `premium` 2027 are independent records).
- **FR-013**: System MUST enforce uniqueness of (tenant, plan identifier, year) so that no duplicate plan can exist within the same year for the same tenant.
- **FR-014**: Editing a plan whose year is earlier than the current calendar year MUST enforce a **partial lock**: cosmetic fields (localised display name, localised description, sort order, active flag, soft-delete / undelete) remain editable; pricing fields (annual fee, registration-fee override, any amount field), eligibility fields (minimum / maximum turnover, maximum duration, maximum member age), member-type scope, benefit-matrix fields, and the partnership-includes-corporate link are read-only. The edit form MUST display a persistent banner explaining the lock, validation MUST block save attempts on locked fields with a clear field-named error, and the UI MUST offer a one-click "Clone to current year and edit there" path. **When F3 introduces inline edit and bulk actions (US7 deferred per critique X1c, 2026-04-11), those surfaces MUST honour this same lock** — the rule is Application-layer and applies to any mutation path regardless of UI — but enforcement of the inline/bulk paths themselves is an F3 concern because F2 ships neither surface.

**Per-tenant fee configuration**

- **FR-015**: System MUST store per-tenant fee configuration (default currency code, VAT rate, registration fee) with the SweCham defaults being currency code = `THB`, VAT rate = 7%, registration fee = 1,000 THB (stored as `(100000, 'THB')` in the minor-unit representation defined by FR-015a) per `docs/membership-benefits-analysis.md`.
- **FR-015a**: Every monetary field on every F2 entity — plan annual fee, plan turnover limits, tenant registration-fee default — MUST be stored as a **non-negative integer `*_minor_units` column** (e.g. `annual_fee_minor_units`, `registration_fee_minor_units`) in the currency's smallest unit (satang for THB, yen for JPY, öre for SEK, cents for EUR). The currency itself is stored **once per tenant** on `tenant_fee_config.currency_code` as a 3-letter ISO 4217 code and is implicit for every plan field in that tenant (critique P3, 2026-04-11 — per-plan currency deliberately NOT stored). All VAT and total calculations MUST operate on integer minor units to avoid floating-point rounding drift, matching Constitution Principle IV (Payment Security).
- **FR-016**: Admin users MUST be able to view and edit the fee configuration values (`vat_rate`, `registration_fee_minor_units`); every change MUST be captured in the audit log with actor, timestamp, and before/after values. **`currency_code` is immutable in F2 once any non-deleted plan exists for the tenant** (critique R1, 2026-04-11): attempts to change it MUST return `422 currency_code_immutable_in_f2` with the affected plan count. The field is set at tenant-creation time (seed script for SweCham in F2; F10 multi-tenant onboarding will own the setter UI for future tenants). F2 does not offer a currency-migration workflow because silently re-interpreting integer minor units across currencies with different decimal places is a data-integrity hazard.
- **FR-017**: System MUST prevent manager-role users from editing fee configuration while allowing read-only access.

**Plan benefits (schema + display)**

- **FR-018**: System MUST persist, for every plan, the structured benefit matrix from `docs/membership-benefits-analysis.md` §2 and §3 including e-blast quota per year, cultural tickets per year, directory listing size, discount scope, co-branded-chamber access, member-to-member access, business referrals, tailor-made services, and — for partnership tiers — event tickets included, booth inclusion, roll-up logo at events, logo on promotional merchandise, video duration, video frequency scope, website-logo months, banner count, newsletter promotion, e-newsletter logo, and directory advertisement position.
- **FR-019**: System MUST capture the "partnership includes corporate plan" relationship so a Diamond / Platinum / Gold plan can declare that its fee bundles the Premium Corporate membership without double-billing.
- **FR-020**: Eligibility constraints (minimum turnover, maximum turnover, maximum membership duration, maximum member age) MUST be stored per plan and displayed on the plan detail view even though F2 itself does not enforce them — enforcement is F3 responsibility. Each plan MUST additionally carry an explicit **member-type scope** flag with values `company`, `individual`, or `both`; the SweCham seed sets Individual and Thai Alumni to `individual` and every other plan to `company`. F3 signup flow branches on this flag rather than inferring scope from other benefit fields.
- **FR-021**: System MUST display the full benefit matrix on the plan detail and edit views grouped by category (Brand Visibility / Events / Additional Benefits / Partnership-only) per the source PDF layout.

**Seed data**

- **FR-022**: System MUST ship a one-off idempotent seed operation that populates the 9 SweCham 2026 plans exactly as specified in `docs/membership-benefits-analysis.md` §4.
- **FR-023**: The seed operation MUST refuse to run if any plan already exists for the SweCham tenant in 2026, and MUST run inside a single transaction so partial failure leaves the tenant clean.
- **FR-024**: The seed operation MUST also populate the SweCham fee configuration row (currency code = `THB`, VAT rate = 0.07, registration fee = `(100000, 'THB')` in the minor-unit representation of FR-015a) if absent.

**Audit**

- **FR-025**: System MUST append an audit entry to the F1 append-only audit trail for every plan-affecting action: create, update, clone, activate, deactivate, soft-delete, undelete, and fee-config update. Each entry MUST include actor, timestamp, tenant, plan identifier, action, and a field-level diff where applicable.
- **FR-026**: System MUST log every admin 404 from the Plans API as a `plan_not_found` info-severity audit event (from the request path — no `BYPASS RLS` query). A separate F13 periodic super-admin scan MUST correlate `plan_not_found` events across tenants and escalate matches to `plan_cross_tenant_probe` high-severity events, satisfying Constitution v1.4.0 Principle I clause 4. F2 ships the request-path emission; the correlation scan is out of scope in F2 and is documented as a known F13 deliverable in the observability runbook (critique E6, 2026-04-11).

**Role-based access**

- **FR-027**: The admin role MUST have full create / read / update / clone / deactivate / soft-delete / undelete / fee-config-edit access to plans for its tenant.
- **FR-028**: The manager role MUST have read-only access to plans and fee configuration and MUST NOT see any create / edit / delete controls in the UI.
- **FR-029**: The member role MUST NOT have any access to the Plans admin area; attempts to access the URL MUST redirect away without leaking plan existence.

**Command palette (cross-cutting)**

- **FR-030**: System MUST provide a global command palette opened with the platform-standard shortcut (⌘K on macOS, Ctrl+K on Windows/Linux) from any admin page.
- **FR-031**: The command palette MUST expose, for F2: search by plan name (localised), quick navigation to individual plans, and admin actions "Create plan", "Clone [current year] to [next year]", filtered by role so non-admins do not see admin-only actions.
- **FR-032**: The command palette MUST be keyboard-first — arrow navigation, Enter to select, Esc to close, and focus returned to the triggering element on close.

**Inline edit + bulk actions — DEFERRED to F3** (critique X1c, 2026-04-11)

- ~~**FR-033**~~ *(deferred to F3)* — inline edit on plan rows
- ~~**FR-034**~~ *(deferred to F3)* — optimistic updates with rollback
- ~~**FR-035**~~ *(deferred to F3)* — bulk selection + bulk actions with 10-second undo
- ~~**FR-036**~~ *(deferred to F3)* — atomic bulk transactions

F2's Plans list is still a sortable, filterable table with confirmation-dialog-based activate / deactivate / delete actions (per FR-001 + FR-009 + FR-010), just without inline cell editing or multi-row selection. Single-row mutations continue to flow through the standard edit form (US3).

**Accessibility & UX**

- **FR-037**: Every screen in the F2 admin surface MUST pass automated WCAG 2.1 AA scans and MUST support keyboard-only operation, visible focus rings, and the project's reduced-motion standard.
- **FR-038**: Every state-changing mutation MUST surface a success or failure notification via the project's standard toast mechanism (sonner per research.md § 10.2 — success 4 s, success-with-undo 10 s, error 8 s, info 6 s, exactly one toast per feedback path, built-in aria-live region for screen readers), localised in the active language.
- **FR-039**: Every destructive action (deactivate, soft-delete) MUST trigger a confirmation dialog with an explicit action verb matching the operation. Bulk destructive actions (bulk deactivate, bulk delete) are deferred to F3 with US7 per critique X1c and will re-adopt this rule when they ship.

### Key Entities

- **Membership Plan** — a single tier or partnership package the chamber offers for a specific year. Uniquely identified by the combination of tenant, plan identifier, and year. Has a localised display name stored as a structured locale map `{ en, th, sv }` where `en` is required and other locales are optional with a "missing translation" indicator, a category (corporate or partnership), a **member-type scope** (`company` / `individual` / `both`) that declares whether the plan targets companies, individual people, or either, an annual fee in the tenant's currency, eligibility constraints, a structured benefit matrix, an active flag, a soft-delete timestamp, and audit metadata. Partnership plans may declare that their fee includes a specific corporate plan's membership.
- **Tenant Fee Configuration** — per-tenant defaults for currency, VAT rate, and registration fee. Exactly one record per tenant. Edited by admin only; read by all roles. Audited on every change.
- **Tenant** — the chamber whose plans are being managed. For F2 the only live tenant is SweCham; the data model and isolation mechanisms are designed so additional tenants can be onboarded in a future phase without schema changes.
- **Audit Entry (cross-feature)** — the F1 append-only audit log extended with plan-related action types. Every plan-affecting change appends an entry with actor, timestamp, tenant, entity, action, and diff.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An admin opening the Plans list on a cold page load sees the first paint of plan rows within 2 seconds at the 95th percentile on a standard broadband connection, including shimmer skeleton transition.
- **SC-002**: An admin can create, edit, clone, or deactivate a plan in under 30 seconds from the moment they press the first keystroke, measured as task-completion time in a scripted walkthrough.
- **SC-003**: A cross-tenant probe test — simulating an admin of Tenant A attempting to read or write a Tenant B plan through direct URL manipulation, API manipulation, or list filtering — returns zero cross-tenant visibility in 100% of test variants. This is verified by an automated integration test that creates two tenants and exercises cross-tenant reads and writes from both directions per Constitution v1.4.0 Principle I clause 3.
- **SC-004**: 100% of user-facing strings on the Plans admin surface are present in all three locales (English, Thai, Swedish) at release, with zero untranslated English keys and zero locale fallback warnings on release-branch CI.
- **SC-005**: The SweCham 2026 seed produces exactly 9 plans (6 corporate + 3 partnership) with annual fees matching the PDF source to the single THB, verified by an automated fixture test.
- **SC-006**: The Plans list admin surface passes automated WCAG 2.1 AA scans with zero violations and is fully navigable by keyboard, verified end-to-end in the project's E2E test suite including a reduced-motion run.
- **SC-007**: Every plan-affecting action produces exactly one audit entry whose diff can be reconstructed into the mutation, verified by an integration test that mutates a plan, reads the audit entry, and asserts the diff matches.
- **SC-008**: The command palette opens within **300 ms of the first `⌘K` press per session** at the 95th percentile (cold-connection path: DNS + TLS + first fetch allowed), and within **100 ms of every subsequent press** at the 95th percentile (warm-socket + `unstable_cache` hit). Measured on a mid-tier laptop with the admin shell already rendered. A `<link rel="preconnect">` hint in the admin shell root warms the socket opportunistically to keep the first-press path under budget (critique P8, 2026-04-11).
- ~~**SC-009**~~ *(deferred to F3 — bulk actions deferred per critique X1c)*
- **SC-010**: A chamber admin with no prior training, given the seeded 2026 catalogue, successfully clones it into 2027 and changes at least one fee within 3 minutes of first login. **Pass criteria**: at least 2 of 3 participants complete the flow within the 3-minute window on their first attempt without consulting documentation, and all participants rate the flow ≥ 4 / 5 on perceived ease of use (tightened per critique P6, 2026-04-11).

## Assumptions

- **Tenant context resolution** — the application can resolve the current tenant from the request context (subdomain, custom domain, signed header, or session claim); for the SweCham single-tenant deployment, the resolver returns the SweCham tenant deterministically. Per Clarifications Q2 (2026-04-11), F2 is the feature that introduces this resolver + the database-layer enforcement as cross-cutting infrastructure; it is not deferred. For now the resolution strategy is "constant SweCham tenant" but the two-layer enforcement is live on day one.
- **Audit log infrastructure reuse** — F1's append-only audit trail is reused as-is for plan-related audit events; no new audit schema is introduced. The audit log is already tenant-scoped.
- **RBAC role names reuse** — the F1 roles `admin`, `manager`, and `member` are reused verbatim. No new role is introduced in F2.
- **Plan identifiers** — plan identifiers are short human-readable slugs (e.g., `premium`, `diamond`) rather than opaque IDs, to improve audit log readability and support copy-paste debugging. Uniqueness is enforced per (tenant, year).
- **Benefit matrix is a structured record** — the benefit matrix is modelled as a set of typed fields rather than a free-form blob, so validation catches typos and downstream features (F3, F4, F7, F8, F9) can query individual benefits directly.
- **Currency formatting** — THB amounts are rendered with Thai-locale grouping separators (e.g., `฿36,000`) in the TH and EN UIs and with Swedish conventions in the SV UI. Per Clarifications Q5 (2026-04-11), the stored value is an integer in the currency's smallest unit (satang for THB) paired with an ISO 4217 currency code — not a plain THB integer — so a future non-Thailand tenant requires no schema migration.
- **VAT at display time** — VAT is calculated at display time using the tenant fee-config rate; the stored plan fee is net of VAT. F4 will freeze the issuance-time rate on actual invoices — F2 does not pre-freeze.
- **No public pricing page** — F2 is an admin-facing feature. A public-facing pricing page on the chamber's own website is out of scope and will be rendered by the tenant's own CMS using the Chamber-OS API at a later phase.
- **No migration from existing data** — there is no Excel import path in F2. The Excel-derived tier list in the original Excel workbook was inaccurate per the 2026 PDF and is not a source of truth. Seed data comes from the PDF only.
- **Command palette is scoped to plans for F2** — the palette's entity search covers only plans in F2; F3 adds members, F4 adds invoices, and so on. The palette component is designed for cross-cutting reuse from the start.
- **Copy catalogue between tenants is F10 scope, not F2** (critique P5, 2026-04-11) — F2's clone operation targets `(same tenant, different year)` only. Copying a plan catalogue from one tenant to another is a multi-tenant onboarding concern that lands with F10, and is explicitly out of scope here.
- **Pre-implementation validation** (critique P1, 2026-04-11) — before `/speckit.tasks`, the maintainer confirms with the SweCham admin that the dominant annual workflow is "clone December → tweak → activate January" rather than "create each plan from scratch". If confirmed, the task ordering inside F2 emphasises the clone path as the primary user journey and treats the create-from-scratch wizard as a secondary path for genuinely new tier additions. Not a spec change — an input to task prioritisation.
- **Soft-delete only** — hard-delete is out of scope for F2. An admin who genuinely needs to purge a plan must contact the platform operator.
- **One admin portal per tenant** — the Plans feature lives under the admin portal surface; the member portal has no plan-management surface.
- **No real-time collaboration** — two admins editing the same plan simultaneously is handled by last-write-wins with a warning; presence indicators and real-time collaboration are out of scope.
- **Open questions tracked** — the five open questions in `docs/membership-benefits-analysis.md` §5 (Q1 start-up 2-year clock, Q2 Thai Alumni age model, Q3 pro-rate on mid-year join, Q4 upgrade/downgrade mid-term, Q5 registration fee trigger) primarily affect F3 and F4 and are called out here for completeness. For F2 they surface only as tooltips and warning copy on the edit form and do not block F2 shipment, but they MUST be resolved at F2's `/speckit.clarify` gate so the data model decisions they influence (nullable vs non-null constraints, audit diff structure) can be baked in before `/speckit.plan`.

## Dependencies

- **F1 Auth & RBAC (shipped)** — provides user identity, session management, role resolution, and the append-only audit log that F2 extends. F2 cannot start without F1.
- **Tenant-context resolver (introduced by F2)** — F2 is the feature that introduces the cross-cutting tenant-context resolver and the database-layer row-level isolation policies required by Constitution v1.4.0 Principle I. Downstream features (F3 onwards) consume this infrastructure unchanged. For the single-tenant SweCham deployment the resolver returns the SweCham tenant deterministically, but the full two-layer enforcement and the cross-tenant integration test are delivered on day one so future tenants can be onboarded without retrofitting the security posture.
- **Project UX component library** — the shimmer skeleton, toast, dialog, and editable-table primitives required by FR-003, FR-033, FR-035, FR-037, FR-038, FR-039 are expected to be available; any missing primitives are added as part of F2 presentation work.
- **Source of truth** — `docs/membership-benefits-analysis.md` is the authoritative specification of the 2026 plan data; `docs/database-analysis.md` was deleted 2026-04-11 and MUST NOT be referenced.
