# Feature Specification: AURA Design-System Migration

**Feature Branch**: `claude/jolly-feynman-8hpoyh` (spec directory `122-aura-design-system-migration`; the session is pinned to this branch, so the usual `nnn-feature-name` branch is not created)  
**Created**: 2026-09-26  
**Status**: Draft  
**Input**: User description: "Move the whole Chamber-OS UI to the AURA design system (aura-react), one module at a time, so the live admin and member portals match the AURA boards on the 'Chamber-OS Portal — Aura' design canvas. Start with the foundation; AURA gaps are fixed in parallel by the AURA maintainer."

## Context — what exists today and what this feature changes

The admin portal (`/admin`) and member portal (`/portal`) are built on a local copy of a generic component kit (48 files under `src/components/ui/`, on Base UI primitives), with a separate toast library, a separate command-palette library, a separate date-picker library, and hand-assembled table screens. Colours, type and spacing live in one hand-maintained global stylesheet.

Over September 2026 the maintainer redesigned every screen — about 300 boards covering desktop (1440 px) and phone (390 px) layouts, empty/error/role states and TH/SV variants — on the **AURA** design system, which the same maintainer owns and publishes (`@jirawatpyk/aura-react` and `@jirawatpyk/aura-tokens`, 5.5.0). The Chamber-OS requirements AURA needed were handed over item by item (the AURA handoff doc, items 1–52); 5.5.0 covers items 1–51, and item 52 (per-row table selection) is open.

This feature replaces the component layer with AURA so the product matches those boards, and ends with one component library, as Constitution Principle VI requires. It changes **presentation only**: no module, database, API, permission or money behaviour changes, and copy changes only where a component swap forces it or a canvas board words it differently (see Session 2026-09-27).

The migration runs **module by module**, one pull request per phase, in the order of the canvas page "Migration plan — AURA". During the migration both libraries coexist; that window is bounded (see FR-004).

## Clarifications

### Session 2026-09-26 (maintainer, before `/speckit.specify`)

- Q: Hybrid end state (AURA only for missing components) or full migration? → A: **Full AURA end state.** Nothing from the old kit remains after the Exit phase.
- Q: Which fonts? → A: **AURA's fonts** (Inter, Noto Sans Thai, Fraunces, JetBrains Mono), served from the app's own origin.
- Q: Toast position — the old top-right, or AURA's options (top or bottom, centred)? → A: **Top, centred.**
- Q: Loading skeletons — keep the shimmer in the UX playbook §2.1, or AURA's pulse? → A: **AURA's pulse**; §2.1 is rewritten.
- Q: How long may both libraries coexist? → A: **At most 10 weeks** after the foundation merges.
- Q: One PR for spec + foundation, or two? → A: **One PR** — spec commits first, then foundation commits.
- Q: Is the system live? → A: **Not yet** (under improvement), which lowers the regression cost; the quality gates still apply in full.

### Session 2026-09-26 (maintainer, after the US0 review)

- Q: During the dual-library window, what colour are legacy primary buttons, and what is the end state? → A: Legacy kit primary buttons and `text-primary` links take the **brand accent** (#2E6397 in light) through the token bridge until their module migrates. The end state follows the AURA design: primary buttons in **AURA ink** (#18181B with white text in light; white with ink text in dark), and the brand blue for links, focus rings, selection and info.
- Q: Must every phase run the local end-to-end suites before merge? → A: **No — at checkpoints only**: after US1 (the shared shell), after the money phases (US4, US8), and before US13. e2e has no CI job and a full local run takes over an hour, so per-phase runs would stall a 13-phase migration; each phase relies on its unit/component tests, the required CI checks (integration smoke, coverage) and the canvas comparison instead. A checkpoint failure caused by an earlier phase is fixed in its own PR before the next phase merges.
- Q: What does the US1 checkpoint cover? → A: **The shell specs, not the full suite** (maintainer, 2026-09-26). US1 changes only the shared frame, so its checkpoint ran the 16 shell specs on chromium and WebKit against main, by test title; every failure was either on main too or fixed in the US1 PR. The first full-suite run moves to the checkpoint after US4 and also covers US1.
- Q: Do the staff bar and the portal header stay the same height (spec 004 SC-009, "identical 56px")? → A: **No** (US1, 2026-09-26): the boards draw the staff bar at AppShell's 56px and the portal header at 72px from 1024px (64px below). SC-009 is superseded; each bar keeps a fixed height, so the no-layout-shift intent stands.
- Q: Can US1 remove the old command-palette library? → A: **Not yet** (found at US1, 2026-09-26): besides the two ⌘K palettes it backs the pickers and the kit's combobox (member, event, template and task pickers; the invoice and plan forms). US1 moves both palettes to AURA `Command`; the library leaves with the last of those modules, at the latest US13, and the lint ban goes global then.
- Q: Does the Swedish-flag navy chrome (navy rail and header, yellow stripe) survive on AURA SideNav / AppShell? → A: **No — dropped**; the shell follows the AURA design. The yellow stripe is removed in US0; US1 replaces the staff sidebar and portal header with AppShell / SideNav as designed.

### Session 2026-09-27 (maintainer, after the board-parity audit)

A read-only audit compared every screen built so far (US1 shell, US2 auth, US3 portal) with its canvas board and found gaps on every page. The maintainer settled four questions before the fixes:

- Q: Portal forms (profile edit / change request, invite a colleague, directory listing, the two language forms) — keep the sticky AURA action bar, or place the buttons at the end of the card as the boards draw them? → A: **As the boards draw them**: primary and secondary buttons at the end of the form card, full width and stacked (primary above) below 640 px, one row at the end on wider screens. The profile edit / change-request form additionally warns before the page is left with unsaved input (the existing `use-beforeunload-guard` hook), since the action bar was its only unsaved-state signal. Staff forms keep action bars where their boards draw them.
- Q: Keep the current wording, or use the boards' wording? → A: **The boards' wording**, added or changed in EN, TH and SV, **except** where a board's text contradicts what the product does; those strings stay as coded: the data export does not include colleagues' contact details, the company name in the directory is not always shown, and the contact email keeps its label.
- Q: Page-title size, title line height, page padding and the portal column differ from the boards on every page — change the shared tokens, or only on migrated pages? → A: **The shared tokens**, so pages not yet migrated take the board sizes too: page title 36 px (portal) / 32 px (staff) from 1024 px, 30 px (portal) / 26 px (staff) below 640 px, line height 1.2 (Thai keeps its taller line height), a 1200 px portal content column with 40 / 64 px top / bottom padding, and staff page padding 28 px (18 px on phones). This supersedes "without its layout changing" in FR-002 for these tokens only.
- Q: US1 and US2 are merged; where do their fixes go? → A: **In the US3 pull request** (#435), checked against the boards before pushing.

### Session 2026-09-27 (maintainer, US4 start)

The US4 boards (`Invoices`, `Invoice-paid`, `Portal-invoice-mobile`, `Portal-credit-note`, `Pay-*`) were read before the tasks were written. The rule from the previous session holds: the boards win unless they contradict the product.

- Q: The plan says the pay sheet is a phone sheet at up to 92 dvh with a Stepper; the boards draw something else. Which? → A: **The boards**: the pay sheet is an AURA `Drawer` on the right, 480 px wide from 640 px and full width and full height below it (AURA's 92 dvh bottom-sheet rule belongs to `Dialog`, not `Drawer`). No US4 board draws a Stepper, so there is none. The existing viewport e2e already asserts the full-height sheet.
- Q: The `Invoices` board has no filter row. Drop the filters? → A: **No**: removing them would remove a feature. The search, status and subject filters stay, on AURA fields. They are shared with `/admin/invoices`, which renders them in AURA from US4 on (as US3 did with shared components); so does the original-receipt badge shared with the staff credit-note screens.
- Q: What around the card form changes? → A: **Only the shell**: Stripe Elements (`<Elements>` / `<PaymentElement>`) and its SAQ-A scope are untouched (Principle IV).

### Session 2026-09-28 (US4 board-parity pass)

The maintainer asked for every gap in the US4 board comparison to be fixed. The invoice filters then got one more change: below 1024 px the search takes its own row and the filters share the next one evenly (from 1024 px it is one row, as before). *(Superseded 2 Oct 2026 by the filter pattern: the invoice filters are compact `FilterSelect`s at their own width that wrap on a phone, as on Members.)* The fixes follow the rule "the boards win unless they contradict the product". Where a board gap was left open, this is why:

- **List resend, no sort, shared pagination.** The invoice list keeps the resend action (removing it would remove a feature); on phone cards it sits in the "⋯" menu. It has no column sort, because sorting needs new server parameters, which a UI swap cannot add. It keeps the shared `TablePagination` with the same URL parameters.
- **Phone card: one labelled download plus a "⋯" menu** (the maintainer chose this from a side-by-side mockup). The board's single download icon cannot say which document it downloads when an invoice has both. So the card shows one labelled button, the invoice while unpaid and the receipt once paid (as on the detail page). A "More actions for {number}" menu beside it holds the other document and "Email me a copy". The menu appears only when it has an item, so a void invoice has none. Both documents stay downloadable (FR-015), and the menu items run the same download and resend as the buttons.
- **Receipt stays primary once paid.** On a paid invoice the receipt download stays the primary button (090 finding #5).
- **No "Receipt preparing…" header button.** A receipt that is still being prepared is shown by the notice (088 T066a), not by a disabled header button.
- **Tax wording stays.** The VAT line and the "Original tax invoice" labels stay as coded (FR-010f). The bill note stays on desktop too, since it is a tax disclosure.
- **Pay button and security footer stay in the drawer body.** The Pay button lives inside the Stripe Elements form, so neither moves into the drawer footer (SAQ-A, Principle IV).
- **Shared items.** The list's invoice-alert title is shared with the US3 dashboard. The fifth "Account" bottom tab comes from US1.
- **Board wording added.** The paid-invoice subtitle, the credit-note title, its "this credit note reduces receipt … by …" notice and contact line, and the "receipt will be ready in a moment" line on payment success are added in EN, TH and SV. The board says "Receipt … is reduced by …", but the original document keeps its total, so the credit note is the subject. The refund line does not promise a refund, because a credit note issued from a refund follows money already returned. Figures and document wording are unchanged.
- **PromptPay amount stays out of this PR.** The PromptPay panel can show a raw satang figure: it compares the currency code with `'thb'` case-sensitively, but invoices carry `THB`. That was a logic bug on `main`, so it was fixed in its own PR (#443), not in this UI swap; the branch picks it up through a merge of `main`.

### Session 2026-09-28 (maintainer, US5 start)

The US5 boards (`Admin-members*`, `Admin-state-members-*`, `Admin-member-*`, `Admin-directory*`, `Admin-change-request*`) were read before the tasks were written. The rule "the boards win unless they contradict the product" holds.

- Q: US5 is about 75 files, and AURA's `DataTable` is a div grid, so every table locator in the members e2e specs changes. One PR or two? → A: **Two.** **US5a**: the members list (DataTable, filters, bulk bar), the directory, and change requests (queue and review). **US5b**: member detail, timeline, benefits, the new / edit forms and every member dialog. This supersedes "one PR per phase" for US5 only.
- Q: The member-detail board has a figures strip and a tab row; the page is one scroll of cards. Which? → A: **The strip, plus section links.** The strip (Outstanding, Membership expires, Primary contact, Engagement) uses only data the page already loads, except Outstanding (Session 2026-09-29). The tab row becomes in-page links to each card, and every card stays on the page, so nothing is hidden behind a tab.
- Q: The members board has a "⋯" actions column; the list has no per-row actions. Add it? → A: **Yes, existing destinations only**: "Open member", and "Edit member" when the viewer may edit members.
- **Bulk actions keep the product's set** (archive, portal invite, auto-invoice on / off, renewal reminder). The board's "Change plan" has no backend, so it is not added. The bar is AURA's `ActionBar`, sticky, right after the table (not above it as on the board): it floats over the list while the table is on screen, so the actions stay in reach down a 50-row page, and it takes its own space at the end, replacing the fixed full-width bar and its spacer.
- **Paging stays**: 50 rows per page and the numbered `TablePagination` with the same `?page=` URL. AURA's built-in pager has only previous / next. The change-request queue keeps its "Next page" link.
- **Kept although the boards omit them** (removing them would remove features): the inline status edit, Shift-click range selection, Ctrl / ⌘+A, "Select all N matching", the risk-band filter and the needs-invite chip.

### Session 2026-09-28 (maintainer, US5a board parity)

Two read-only audits compared every US5a board with the live screen and found about 158 differences. Most of them were the board's pixel values disagreeing with AURA's own component defaults.

- Q: Match every pixel of the boards, or only some differences? → A: **AURA's component defaults win over a board's pixel values** (spacing, sizes, radius, type scale, table cell padding, button padding, empty-state spacing). **The board wins on content, structure, order, icons and copy.** A board value that is clearly better goes to the AURA handoff, never into a per-page override. Styling that has to reach into AURA's internal classes is a stand-in with an open handoff item.
- Q: The members count shows twice (above the table and in the pager). Which stays? → A: The count above the table shows only while a search or filter is applied. Unfiltered, it stays in the live region for screen readers, and the pager's range says it.
- Q: Which portal badges does the Primary contact column show? → A: Only the states that need action (Not invited, Invited, Expired). A linked contact shows none.
- Q: The phone card has a checkbox, a ⋯ menu and seven fields; the board has neither and four fields. → A: **As the board.** No checkbox, no ⋯, no flag. Four fields: Member No., Plan (no year), Primary contact, and the engagement band. Tapping a card opens the member. Bulk actions and the Edit shortcut stay on tablet and desktop.

### Session 2026-09-29 (maintainer, US1–US4 parity cleanup, T511)

- Q: US1–US4 overrides that carry only a board pixel value on an AURA component (the tab panel gap, the data-export rows and header, the change-request diff sizes, the staff rail, the phone bar, the bottom nav), with no AURA prop to replace them: keep them as stand-ins, or AURA's default? → A: **AURA's default**, each change stated on the parity page. Only an override that carries structure or accessibility stays, as a labelled stand-in with a handoff item.
- Q: Guard against new unlabelled reaches? → A: **A ratchet test** over every `MIGRATED_PATHS` entry (US1 onward, US5a included, and each later phase as it joins) and `globals.css`: a reach needs `stand-in until AURA #NN` naming an item still open in `docs/aura-adoption.md`, or `AURA app content:`; the test has positive controls and reads CRLF sources like LF ones.

### Session 2026-09-29 (maintainer, US5b start)

The US5b boards (`Admin-member-detail`, `-timeline`, `-benefits`, `-new`, `-edit`, each with `-mobile`, and `Admin-member-plan-change`) were read before the tasks were written. No dialog opened from the member detail page has a board; the canvas draws only the plan-change confirmation.

- Q: US5b is about 12,000 lines (the detail page 1,500, the form sections 2,600, the dialogs 2,500). One PR or two? → A: **Two.** **US5b-1**: member detail, timeline, benefits and every dialog or banner opened from the detail page (contacts, archive, erase, restore primary, renew lapsed). **US5b-2**: the new / edit forms, the plan-change, bundle-warning, override-reason and soft-duplicate dialogs, and the notification-language card.
- Q: The detail page does not load the member's outstanding balance (its invoice list follows the page's status filter). Where does the strip's Outstanding come from? → A: **The existing member invoice read**, asked for issued invoices only (the one unpaid state: a credit follows payment), up to 100: the sum, the count and the earliest due date. It says "partial" beyond 100 and is shown only to roles that may read invoices. No new backend.
- Q: AURA's `Combobox` has no option groups and no typed value outside its list; the member form's country field groups TH and SE as "Suggested", and province / district / sub-district take a typed name. → A: **Country moves to AURA** with TH and SE listed first and no group heading (as the directory's country field). **The three address fields stay on the old combobox** (`NOT_YET_ON_AURA`) with an AURA handoff for typed values and groups, and move when it ships (US5b-2). *Superseded 2026-09-30 (US5b-2 start): AURA 5.16 shipped both (handoff #105).*
- **Dialogs with no board** use AURA's `Dialog` / `ConfirmationDialog` defaults and keep their content, copy and behaviour.
- **Kept although the board omits them** (removing them would remove features): the erased, archived and no-primary-contact banners; the technical details (member number, IDs), copy buttons and flag; the marketing badge and switch per contact and the marketing-audience link; the invite and re-send buttons and badges; the member invoice filters (the same `invStatus` / `invYear` / `invQ` URL); the renew action and at-risk band; the full change-request history; the per-contact data-export scope.
- **Invoice row actions** (view, record payment, credit note, void) move into the board's "⋯" menu; for a manager they are disabled with the reason in the item, as the tooltip said before.
- **Section links** list only the sections present for the viewer's role and the feature flags. **On a phone** the header is Edit, Benefits and "⋯" as the board draws it, and Erase and Archive open from the menu (maintainer, 29 Sep, after the stacked buttons "fell" into three rows: a narrow ux-standards § 19 exception recorded there; both still open their confirmation dialogs, and from 640px up they stay visible buttons). Data export stays its own section. The contact rows take the board's compact phone layout (role · language under the name, email and phone as links). A contact's Remove may sit in its row's "⋯" menu: it is soft and confirmed (§ 19's low-irreversibility exception).
- **After the US5b-1 reviews** (UX, financial, PDPA, i18n): a pending change request shows as an info alert with Review above the strip **at every width**, not only on a phone, sharing one read with the change-request section; Renew sits in the renewal card's body because AURA's card head does not wrap; the timeline card is titled "Timeline" (the name its section link uses) with a quiet "View all activity →"; the invoice card's count sits beside its heading and "New invoice" is primary; member invoice amounts use the board's "38,520.00 THB" form, the same as the strip; the strip's note reads "overdue since" once the earliest due date has passed (the portal's Bangkok-day rule); an Erase refusal is an inline focused alert in the dialog (ux-standards § 6.4). The table's `owing` flag, which also highlights void and partly credited rows, is a logic fix for its own PR.

### Session 2026-09-30 (maintainer, US5b-2 start)

The US5b-2 boards (`Admin-member-new`, `-new-mobile`, `-edit`, `-edit-mobile`, `Admin-member-plan-change`) were read before the tasks were written. The bundle-warning, override-reason and soft-duplicate dialogs have no board: they use AURA `Dialog` defaults and keep their content, copy and behaviour.

- **Combobox (amends Session 2026-09-29):** AURA 5.16 shipped `groups` and `allowCustomValue` (handoff #105), so the member form leaves the old combobox entirely. Country keeps its "Suggested" group (TH, SE) above "All countries" through `groups`; province, district and sub-district take a typed name through `allowCustomValue`, with the Thai name as the option's second line. The postcode lookup, the cascade and the kept-current-value rule are unchanged. `ui/combobox` stays for its other callers (member picker, invoice form, event fee).
- Q: The board's plan options show no price ("Premium Corporate — 2026"); the form shows the fee in the option today. → A: **The plan name is the label as the board draws it; the fee stays on the form.** AURA `Select` lists one line per option, so (maintainer, same day, after a preview of the three layouts) the selected plan's annual fee is the field's hint ("Annual fee: 45,000.00 THB"), not a second line in the list. The plan-change confirmation keeps its fee tiles.
- Q: Registration date and a contact's date of birth are native date inputs. → A: **AURA `DatePicker`**: Buddhist Era displayed for `th`, the stored value unchanged (ISO Gregorian `YYYY-MM-DD`). On edit, the registration date is read-only text as the board draws it.
- Q: The phone boards pin Cancel (1/3) and the primary button (2/3) to the bottom of the screen. → A: **Pinned, as the board draws it** (AURA `ActionBar`); from 640px up the buttons are a right-aligned row at the end of the form, not sticky.
- **Frame:** one 672px column, the "* fields are required" note, Cancel at the top right on desktop and a "← back" link on phones, one card per fieldset; the edit page shows the notification-language card first (saved on its own), the incomplete-address warning with its "Complete the address" link, and the note that other contacts are managed on the member record.

- **Board parity (T580, after screenshots against the five boards):** the 672px column sits at the page's start edge as the staff form boards draw it (not centred); the required-fields note's "*" takes the danger colour like each field's; "Add a secondary contact" carries AURA's plus icon and loses the "+" from its words (EN/TH/SV); the contact phone gets the boards' hint "International format, e.g. +66812345678" (EN/TH/SV, second parity pass); the plan-change confirmation stays an `alertdialog` (a stray scrim click does not dismiss the gate), as the old one was. Kept although the boards omit them: the entity-type help popover, "Additional details" as an AURA Accordion (the boards draw a bare disclosure), and the billing-address group.

### Session 2026-09-30 (maintainer, US6 start)

The US6 boards (`Admin-plans`, `Admin-state-plans-empty`, `Admin-plan-detail`, `Admin-plan-new`, `Admin-plan-edit`, `Admin-plan-edit-locked`, `Admin-plans-clone`, and the `-mobile` variant of each) were read before the tasks were written. The wizard is drawn at step 3 only. No board draws a dialog, the wizard's error state or steps 1, 2 and 4: those keep their content and behaviour on AURA defaults.

- Q: The spec asks that a wizard step with errors shows them in "the AURA error summary and stepper"; AURA 5.17's `Stepper` has no per-step error state (the old one marked the failing step). → A: **Error summary, and the wizard stays on the step.** A step with more than one error shows AURA `FormErrorSummary`; each field shows its error through AURA's `error` prop. Next does not advance; Save goes back to the first step with an error and focuses its first invalid field. The stepper shows progress only. An AURA handoff asks for a per-step error status (item 112, not blocking). *Update (30 Sep, Addendum 19): AURA 5.18.0 ships it; the failing step shows the Stepper's error status while it still has errors.*
- Q: The boards draw "฿" before the money fields; AURA `TextField` has a trailing unit only. → A: **"THB" as the field's suffix**, as the rest of the product writes amounts ("36,000.00 THB"). Whole baht in, minor units stored, the same maximum.
- Q: The locked (prior-year) edit board lays a lock icon over each locked field; AURA has no locked state. → A: **The warning `Alert` with its "Open the {year} version" action, then locked fields that cannot change**: text and money fields `readOnly` with AURA's `lock` icon, Selects `disabled` with the same icon, Switches `disabled`. Each locked field tells a screen reader "Locked: historical plan". The lock rule and the server check are unchanged. *(Updated 30 Sep, AURA 5.19 / Addendum 20 #113–#114: Selects and Switches are now `readOnly` too, so every locked field stays in the tab order; Switches show the lock at the end of the row.)*
- **From the boards:** no board uses a segmented control. The small fixed-option fields (category, member type, discount scope, video duration and frequency, directory position) and the list's category filter stay AURA `Select`. This replaces "segmented controls" in User Story 6. The clone page's confirmation dialog, which no board draws, stays as an AURA `Dialog` with `role="alertdialog"`.

### Session 2026-09-30 (maintainer, US7 start)

The US7 boards were read before the tasks were written:
- **Pipeline:** `Admin-renewals` (+`-mobile`), `Admin-renewals-needs-action`, `Admin-renewal-mark-paid` (+`-mobile`), `Admin-state-renewals-empty`, `Admin-state-renewals-error`.
- **Cycle detail:** `Admin-renewal-cycle` (+`-reminded`, `-pending`, `-mobile`).
- **Queues and settings:** `Admin-renewal-tasks` (+`-mobile`), `Admin-tier-upgrades` (+`-accept`, `-mobile`), `Admin-renewal-schedules` (+`-mobile`).
- **Portal:** `Portal-renewal`, `Portal-renewal-processing`, `Portal-renewal-success`, each with `-mobile`.

Only two dialogs are drawn: the offline payment ("Record an offline payment?") and "Accept tier upgrade?". The others keep their content and behaviour on AURA defaults: send reminder, bulk mark-paid with its settlement preview, snooze, outreach, reactivate / reject, cancel cycle, done / skip / reassign task, and escalate / dismiss.

- Q: US7 covers 52 files on the old kit (about 16k lines) and 24 boards; one PR would be too large to review. → A: **Three PRs:**
  - **US7a**, the pipeline page: money band, "Renewals by month", pipeline table, bulk bar and mark-paid dialogs, at-risk section, pending review, lapsed tab, members-without-cycle tray, empty and error states.
  - **US7b**: cycle detail, escalation tasks, tier upgrades and reminder schedules.
  - **US7c**: the portal renewal pages.
- Q: The portal renewal pages (`/portal/renewal/[memberId]` and its success page) belong to no user story. → A: **US7 (as US7c).**
- Q: US7 is not tagged as a money phase, but it records offline payments, previews bulk settlements, shows frozen prices and runs the portal renewal confirm. → A: **Treat US7 as a money phase.** Each of its PRs gets a financial-integrity review (FR-010f). Every amount, VAT line and settlement figure stays as it is.
- Q: On a phone the pipeline renders a second, separate card list beside the desktop table; User Story 7 asks for one table that stacks. → A: **One AURA table that stacks into cards below 640px.** Selection, row actions and the dialogs work from the same rows, and the separate card list goes. The phone e2e reads the stacked table. The URL contract for sort, filters and paging is unchanged (FR-015).
- **From the boards (pipeline):**
  - Four money tiles: Collection rate, Past due (with the prior-years line), Collected this month, Due soon.
  - Section tabs Pipeline / Pending review / Tasks / Tier upgrades, with counts.
  - The All / Needs action toggle, a tier filter, and the stage chips T-90, T-60, T-30, T-14, T-7, T-0, Suspended, Terminated.
  - Table columns Tier, Company, Expires, Urgency, Last reminder, Status, Invoice and Actions. Actions are "Send reminder" plus a ⋯ menu.
  - A bulk bar: "{n} selected · Send reminder · Mark paid · Clear selection".
  - The "Renewals by month" bar chart, whose bars filter the table.
  - "Members without a renewal cycle".
  - On needs-action: the at-risk counters and table.

### Session 2026-10-01 (maintainer, US7a review)

- Q: The `Admin-renewals` board tones the tier badges with status colours (Start-up and Thai alumni warning, Partnership success, Premium accent). The urgency pill in the same row uses warning to mean "renewal due, act", so an amber tier reads as a member that needs attention. Should tiers keep the board's colours? → A: **No. A tier is a category, not a state, and never takes a status tone.** Partnership is `accent`, as on the plans list; every other tier is `neutral`. Warning, success and danger stay for urgency and risk. The label names the tier. The `Admin-renewals` boards are updated to match, and US7b uses the same tier badge.
- Q: The US7a reviews found copy that predates the migration: TH "บันทึกการชำระเงิน" on the row menu and bulk bar where the dialog button says "บันทึกชำระเงิน"; the TH pending-review count read out as "รอตรวจสอบ" beside the tab "รอการพิจารณา"; SV "Inkasseringsgrad", which reads as a debt-collection rate; and no tax-document warning in the bulk mark-paid dialog, which issues one tax invoice/receipt per member. The "no copy beyond the swap" rule would defer them. → A: **Fix them in US7a.** TH "Mark paid" reads "บันทึกชำระเงิน" everywhere; the count uses "รอการพิจารณา"; SV reads "Inbetalningsgrad"; the bulk dialog carries the single dialog's warning, per member (EN, TH, SV). `renewals-copy-consistency.test.ts` pins the first three. No request, amount or behaviour changes.
- Q: On the parity page the maintainer asked: the money band's figures are 28px where the board draws 24px; on a desktop the "Tier" label above the tier select makes the gap between the work-queue toggle and the stage tabs 96px against the board's 72px; on a phone the work-queue card keeps its 16px padding, so the row cards sit 33px in instead of on the 16px page gutter (the board, the members list); and at 1440 the board's "Last reminder" column is hidden (its 1080px breakpoint against a 1071px table). → A: **Keep the 28px figures (AURA's `Stat`; AURA drops them to 24px on a phone itself). Show "Tier" only on a phone; on a desktop the select keeps the name for screen readers ("All tiers" says what it filters). On a phone the work-queue card has no frame, border or padding (`flushBelow="sm"`). Last reminder shows from a 1040px table and Invoice from 1180px**: most rows read "—", and an issued bill already shows as the "Bill issued" badge beside the urgency pill. The actions column is 200px, which still fits SV "Skicka påminnelse" and stops the 1280 table scrolling sideways. The `Admin-renewals` boards are updated to match. The plans list (US6) follows the same phone rule: its table card is frameless with no border or padding below 640px.

### Session 2026-10-01 (maintainer, US7b start)

The US7b boards were read against the code before the tasks were written: `Admin-renewal-cycle` (+`-reminded`, `-pending`, `-mobile`), `Admin-renewal-tasks` (+`-mobile`), `Admin-state-tasks-manager`, `Admin-tier-upgrades` (+`-accept`, `-mobile`), `Admin-renewal-schedules` (+`-mobile`).

- Q: US7b is 37 files and about 7,750 lines over four pages, the size of US7a. One PR or two? → A: **Two.** **US7b-1** is cycle detail and the tier upgrade queue. Both touch money (frozen price, invoice total, mark-paid, reject & refund, accepting a fee increase), so the PR gets a financial-integrity review. **US7b-2** is escalation tasks and reminder schedules, which hold the last cmdk users (task reassign, the schedule step's task type).
- **Decided from the boards (US7b-1), applying the Session 2026-09-27 rule that the board decides content and copy:**
  - **Cycle detail header:**
    - The actions sit in the page header, as the board draws them: "Record payment on {bill}" or "Mark paid offline" as the primary action, then "Cancel cycle" in the danger style. On a pending cycle the actions are "Approve reactivation" and "Reject & refund".
    - On a phone, only the primary action stays in the header, full width. "Cancel cycle" moves to a danger zone at the end of the page, and on a pending cycle so does "Reject & refund" (no `-pending-mobile` board is drawn; the UX review asked that the refund never sit beside the primary action on a phone).
    - The pending notice is a warning `Alert` under the header.
  - **Cycle detail cards:**
    - "Member & plan" is one list (Company, Primary contact, Tier, Plan name, Frozen price, Term, Currency); the Member and Plan sub-headings go.
    - On a phone, "Linked invoice" comes first.
    - The pending board omits the Activity card and the Currency row. That is an abbreviated board: the page keeps one layout for every status.
  - **Copy, money labels:** "Frozen price (excl. VAT)" and "Total (incl. VAT)".
    - The board's "Total (incl. VAT 7%)" is not followed. The total comes from the invoice, which carries its own VAT snapshot, and the invoice register already reads "Total (incl. VAT)".
    - The phone tier-upgrade list and the Accept dialog read "Fees exclude VAT." for the same reason.
  - **Cycle status pill:** uses one tone map, shared with the member-detail Renewal health card (US5b): upcoming and reminded neutral, awaiting payment progress, pending admin reactivation warning, completed ready, lapsed and cancelled blocked. The board's progress for reminded and blocked for pending are not followed, so a cycle status reads the same in both places.
  - **Tier badge:** the US7a `TierBadge` (Session 2026-10-01, US7a review), not the boards' status tones.
  - **Tier upgrade queue, rows:**
    - Accept plus a ⋯ menu with Escalate and Dismiss, at every width. This replaces three inline buttons on a desktop.
    - The ⋯ button is named for its row: "Escalate or dismiss — {member}".
    - The Current plan and Suggested plan cells show the annual fee under the plan name ("{fee} excl. VAT"), from the plan read the page already makes.
    - Amounts keep their current format.
  - **Tier upgrade queue, layout:** one table that stacks into cards below 640px.
    - The phone board puts the reason and the plan move on full-width lines. An AURA stacked card has no full-width field, so these cells wrap inside their half of the card. This is AURA handoff #120, recorded in `docs/aura-adoption.md`.
  - **The actions follow the routes' own guards, not the boards' samples:** the `-reminded` board draws "Mark paid offline", but the mark-paid route accepts only an upcoming or awaiting-payment cycle, so a reminded cycle offers Cancel cycle alone (unchanged from today).

### Session 2026-10-01 (maintainer, US7b-2 start)

The maintainer approved the US7b-2 plan. Its boards were read against the code: `Admin-renewal-tasks` (+`-mobile`), `Admin-state-tasks-manager`, `Admin-renewal-schedules` (+`-mobile`). US7b-2 touches no money, so it gets UX and i18n reviews and no financial review. It is a UI swap: the done, skip and reassign requests and the schedule save keep their bodies, endpoints and toasts.

- **Decided from the boards, applying the Session 2026-09-27 rule that the board decides content and copy:**
  - **Escalation tasks, rows:**
    - "Done" (secondary) plus a ⋯ menu with Skip, Reassign and View timeline, named for its row: "Skip, reassign or view timeline — {type}, {member}".
    - "View timeline" moves from the member cell into the menu, so the member cell holds one link.
    - Due shows the date with a danger "Overdue" badge; Assigned to shows the name over the role.
  - **Escalation tasks, layout:**
    - One table that stacks into cards below 640px. A card shows the member, the tier with the task type, then the due date with the assignee; Expiry and Status stay in the table only.
    - Done fills the card's last row beside the ⋯ menu.
  - **Escalation tasks, filters:**
    - The overdue toggle card, then Status (Open, Done, Skipped) and Assignment (All, Mine, Unassigned) as segmented groups, then the Task type select.
    - A link that already carries a colleague's id in `assignment` keeps working (no button is pressed). The board draws three buttons.
    - For a manager, the read-only note sits above the filters, with no Done button and no ⋯ menu. The overdue toggle stays, since it only filters: the `Admin-state-tasks-manager` board draws an empty queue, where there is nothing overdue to toggle.
    - Status and Assignment are AURA toggle chips (`Tag selected`, `aria-pressed`), so the pressed chip carries a check, not only a fill. A hand-built pill track read at about 1.2:1 in dark mode (UX review).
  - **Escalation tasks, the timeline after the move (UX review):** moving "View timeline" into the menu must not take it away from anyone. A row that is closed (Done or Skipped), or any row for a manager, shows a "View timeline" link in the actions column ("View timeline — {type}, {member}" for screen readers) instead of Done and the menu, which would have nothing to act on. So the actions column renders for every role.
  - **Out of scope, filed separately:** once the overdue toggle is pressed, the page stops counting overdue tasks, so the toggle disappears and only Back turns the filter off. The count is a server read in `page.tsx` that also feeds the overdue gauge. That is a logic change, so it ships in its own PR (Session 2026-09-27 rule).
  - **Reminder schedules, chart:** the timeline is a chart on a day scale (email markers on the upper lane, task markers on the lower one, a dashed line at the renewal date), replacing the step strip. It names the schedule in one sentence for screen readers. Axis labels are kept or dropped by each label's width at the chart's measured width, and a label at either edge anchors to that edge, so a long TH or SV "Due" never collides on a phone.
  - **Reminder schedules, step card:**
    - Delivery channel (Email or Task) as a radio group, and Send timing as a select ending in "Custom…".
    - A task step has a Task type combobox that accepts a typed type, with the hint "Can't find the task type? Type to add your own.", and an Assignee role select.
    - The email preview keeps today's copy in the board's check-line form; its no-copy warning stays a warning.
    - The timing sentence heads each card (h3), and the move and remove buttons are described by it, so nine cards no longer read as nine identical "Move up" buttons. A step moved to either end hands focus to the other arrow.
  - **Reminder schedules, editing:**
    - Removing a step keeps its Undo toast; no confirm is added.
    - The save bar holds "{n} steps · Last saved …", "Add step" and "Save schedule". It sits under the steps from 640px and sticks to the bottom of a phone screen.

### Session 2026-10-01 (maintainer, US7c start)

The maintainer approved the US7c plan. Its boards were read against the code: `Portal-renewal`, `Portal-renewal-processing` and `Portal-renewal-success`, each with `-mobile`. US7c is part of a money phase (Session 2026-09-30), so it gets a financial-integrity review as well as the UX and i18n reviews. It is a UI swap:
- the confirm request keeps its endpoint, its one `content-type` header and its body (`cycleId`, plus `newPlanId` only on a change and `acknowledgeDowngrade: true` only after the dialog);
- the `pay_url` redirect, the error codes and the client-error beacon are unchanged;
- every amount still comes from the same formatter.

- Q: The board draws no downgrade confirmation: the warning and the price-change panel stand in for it. Today a downgrade opens "Confirm a lower-priced plan", and only that dialog sends `acknowledgeDowngrade: true`. → A: **Keep the dialog**, as an AURA alertdialog. Dropping it would change the money request. The board's inline warning and price panel are kept as well.
- Q: The board's "Choose a plan" is a flat list, with the price in each option and "(current)". Today's list is grouped into higher-priced, current and lower-priced plans. → A: **Keep the groups** (option groups in AURA's select) and use the board's option text, "{plan} — {price}", with "(current)" on the current plan. AURA's select has no separate closed-field text, so the closed field shows the full option, as the board does.
- **Decided from the boards** (Session 2026-09-27 rule: the board decides content and order):
  - **Renewal page:**
    - "Membership plan" and "Benefit summary" cards on the left, with the Confirm card in a 420px column on the right from `lg`; one column below.
    - The tier shows as an accent badge. A tier is a category, so it never takes a status tone (US7a decision).
    - Metered benefits are AURA progress bars.
  - **Confirm card, top to bottom:**
    - a two-step stepper, "Confirm renewal" (current) then "Pay invoice";
    - the plan select;
    - the change warning;
    - the price-change panel (current, new, difference);
    - the full-width "Confirm renewal" button;
    - a line saying the next step is the invoice, paid by card or PromptPay.
  - **First renewal:** the welcome note is an AURA info alert.
  - **Processing and success:** a centred hero with a check, then a "Renewal details" card, then the actions.
    - Processing reads "Payment received / We're confirming your renewal". Its details say the new expiry appears once confirmation arrives, and a receipt still being prepared shows as a busy "Receipt preparing…" placeholder.
    - Success reads "Renewal complete / Thank you — your membership is active", with the new expiry and a "Completed" status pill.
    - On a phone the actions stack at full width.
- **Kept from the code over the boards:**
  - **Amounts** keep the current format (`฿36,000.00`); the board writes "36,000.00 THB".
  - **Dates** keep the long form everywhere; the board mixes "31 Dec 2026" and "31 December 2027".
  - **Downloads:** the success page keeps its five outcomes (receipt ready, paid with the receipt still preparing, unpaid invoice, no invoice, fetch failure). The board draws only the first and the second.
- **From the reviews:**
  - **Success hero (financial):** "Renewal complete" shows only once the cycle is completed. Until then the page shows the processing hero, so a cycle still awaiting payment never reads as complete.
  - **Plan select (financial):** when the current plan is missing from this year's list (made inactive, or not carried over), the closed field still names it rather than the first option.
  - **Gate notices (UX):** each notice is an h2 card holding the alert, so the right column keeps its heading.
  - **Welcome note (UX):** the welcome is a note whose title is its text, with no duplicate name.
  - **Receipt placeholder (UX):** "Receipt preparing…" is busy, not a live region.
- **Known trade-offs, kept:**
  - On a 320px phone, AURA's closed select cuts a long TH or SV option short. The price panel below always shows the price.
  - The current plan's option shows this year's catalogue price. The panel shows the locked-in price. The two can differ; that is unchanged from before US7c.
- **From the parity pass:**
  - The page grid has an explicit `minmax(0,1fr)` track below `lg`. The implicit `auto` track grew to the select's option text, and phones scrolled sideways.
  - The price band rules a line between its three rows, as the board draws it.
  - The success hero centres a title shorter than its subtitle (TH).
- **Out of scope, filed separately:** the confirm route's `invoice_already_exists` 409 has no message of its own, so the member sees the generic error. Mapping it is a behaviour change (Session 2026-09-27 rule).

### Session 2026-10-02 (maintainer, US8 start)

The maintainer approved the US8 plan. Its boards were read against the code:
- **Lists:** `Admin-invoices`, `Admin-state-invoices-setup`, `Admin-credit-notes`.
- **Invoice detail:** `Admin-invoice-draft`, `-issued` (+`-mobile`), `-overdue`, `-paid`, `-credited`, `-manager`, `-auto-refund-failed`, `Admin-voided`.
- **Create, issue and pay:** `Admin-invoice-new`, `Admin-invoice-issue`, `Admin-record-payment` (+`-mobile`).
- **Refunds:** `Admin-refund-full`, `-partial`, `-settling`, `-settled`, `-failed`, `-waived`.
- **Void and credit:** `Admin-void` (+`-mobile`), `Admin-credit-note` (+`-mobile`), `Admin-credit-note-detail`.
- **Registers:** `Admin-invoice-registers` (+`-mobile`), `Admin-registers-empty`, `-invalid-range`, `-load-failed`, `-re`, `-zero-rate`.
- **Settings:** `Admin-invoice-settings`.

`Invoices`, `Invoices-mobile` and `Invoice-paid` are member-portal boards (US4). `Proposal-void-reissue` is a proposal for the voided page.

US8 is a money phase, so each of its PRs gets a financial-integrity review as well as the UX and i18n reviews. It is a UI swap: every fetch URL and body, typed phrase, router push and refresh, error-code router, toast, amount formatter and date helper is unchanged. None of these requests sends an idempotency header today, and none is added.

- Q: US8 covers 61 files on the old kit (about 17k lines) and 36 boards, more than US7. → A: **Three PRs:**
  - **US8a:** the invoice list (table, row menu, auto-renewal review queue, record payment, CSV export, setup and empty states) and the new-invoice page (membership and event fee).
  - **US8b:** the invoice detail page with its dialogs (issue, delete draft, refund, email-failure and auto-refund alerts), the payment activity timeline, the void page and the new-credit-note page.
  - **US8c:** the credit-notes list and detail, the tax-document registers and the invoice settings.
- Q: The invoice detail boards are drawn two ways. Some show the bare number with a badge over an unframed list; others show "Invoice {number}" with a status pill over a "Details" card. → A: **One layout: "Invoice {number}" with an AURA status pill, then a "Details" card holding the fields, then a separate totals block** (subtotal, VAT, total). A draft reads "Draft invoice". The pill tones are the list's: Paid `ready`, Issued `progress`, Overdue `blocked`, every other status `neutral`. The badge-style boards are updated to match.
- Q: Three phone boards are marked "proposed": record payment as a bottom sheet, a bottom action bar on the invoice page, and stacked buttons on the void page. → A: **Adopt all three.** They are layout only:
  - below 640px, record payment opens as a bottom sheet; wider screens keep the centred dialog. AURA's dialog is itself a bottom sheet below 640px (up to 92% of the height, rounded top corners), so both are one AURA dialog;
  - on a phone the invoice page ends in a bar with the total (incl. VAT) and due date, the main action and the ⋯ menu, and Void moves into that menu;
  - on a phone the void page stacks full-width buttons, Void above Cancel.
- Q: The user story says the registers have a sticky totals footer, but the board and the code both put the summary line above the table. → A: **Keep the summary line above the table, with no footer.** On a phone the register rows become cards, as the board draws them. The user story is corrected.
- **Decided from the boards** (Session 2026-09-27 rule: the board decides content and order):
  - **Invoice list columns**, in order:
    - Invoice No.: the number link, with "Issued {date}" and the credit-note count under it. The separate Issued column goes.
    - Buyer: the name, the Event chip and the subtitle.
    - Status, Due.
    - Receipt No.: with "Receipt generating…" or the online payment method under it.
    - Total; Actions.
  - **The queue and method columns stay where they are.** The review-queue column (auto-renewal view) and the Method column (online-payments view) still appear only in those views.
  - **Row actions:** "Record payment…" on issued and overdue bills for admins, and a ⋯ menu holding the invoice, bill or receipt downloads. A receipt whose PDF failed shows a "Receipt failed" link to the invoice under its number. In the review-queue view the issue and discard actions stay in the row.
  - On a phone the table stacks into cards (the US7a rule): number as the title, then buyer, due and total, with the actions in the card footer.
  - **Setup state:** the "Finish invoice setup" sentence, and "Configure Invoicing" for admins only.
- **Kept from the code over the boards:**
  - **Typed confirmations** keep their phrases: refund `REFUND {company}` (case-sensitive), credit note `CREDIT`, void the bill number. The boards type the receipt number; changing a phrase changes what the server-side guard and the e2e expect, so it would be a behaviour change.
  - **List filters** stay on the AURA filter bar from US4, which the portal shares. The board draws hand-built dropdown buttons.
  - **Amounts and dates** keep their current formats.
  - **Settings sections** the board does not draw (document notes, payment, branding and logo) keep their content on AURA's defaults.
- **US8a review outcomes** (UX, i18n and financial reviews of PR #496):
  - **Record payment's summary box** labels the figure "Invoice total (incl. VAT)", not "Amount received". An event buyer may withhold 3% tax, so the money that arrives can be less than the total.
  - **The receipt's state wherever Receipt No. is not shown.** The board's phone card leaves out Receipt No. The grid also hides that column when the table is narrower than 1000px (a 1280px laptop), so the other columns fit the card without scrolling sideways. In both cases "Receipt generating…" or the "Receipt render failed" link appears under the number.
  - **Record payment cannot be dismissed while the payment is being sent.** A tap on the scrim never closes it. After a successful payment, focus moves to the row's ⋯ menu.
  - **Sorting stays out of scope.** The board marks Invoice No. and Due as sortable, but the list has never sorted. Adding it would be a behaviour change, so it is not part of this UI swap.
  - **On a phone the list header keeps only "New invoice" in its row.** Tax registers and Export CSV… move into a ⋯ menu beside it, the US5a members header and US5b-1 ⋯ precedent (maintainer comment on the parity page, 2 Oct). The export dialog opens from the menu, and focus returns to the ⋯ button. From 640px up, the three buttons show as before. The filters stay on the shared AURA filter bar.
  - **One button icon rule for every migrated screen** (maintainer, 2 Oct, applied in this PR). The rule is in `docs/aura-adoption.md` § Button icons. An audit of every preview view against the boards found four buttons that broke it, all fixed here:
    - Try again on the shared load-error card;
    - Send reminder in the renewal pipeline;
    - Invite colleague on the portal profile;
    - the invoice list's empty-state New invoice.

    Record payment and Create draft were fixed earlier in this PR.
  - **One list card rule** (maintainer, 2 Oct: "follow what the design should be"). The boards disagree, so the rule is in `docs/aura-adoption.md` § List card: a page whose main content is a list frames its filters and table in one card, frameless below 640px; a list that is one section of a page keeps its section card. Members and Change requests, the two migrated lists that broke it, take the card in this PR, with their skeletons.
  - **One filter pattern, applied in its own PR** (maintainer, 2 Oct). The boards disagree, so the rule is in `docs/aura-adoption.md` § Filters: AURA `FilterBar` with `FilterSelect`, one date-range control, toggle chips, filtering as you pick, a "More filters" popover past four. Report forms keep a run button. Change requests, Plans and the invoice filters move to it in a PR after AURA ships #127 (tables edge to edge inside the list card) and #128 (a compact date-range filter). The mock was reviewed on 2 Oct. The URL parameters each page sends stay the same. Applied on AURA 5.26 (2 Oct): every applied filter is a removable chip in the bar, so its "Clear filters" appears; the change-request queue drops its Apply button, phone toggle and GET form, so there is no pre-hydration submit (`FilterDateRange` has no form field, and nothing in the bar is typed).
  - **Page column widths follow AURA's sizes** (maintainer, 2 Oct, AURA's answer to #126). The form column becomes `Container size="narrow"` (720px, was 672), still at the start edge on the staff forms (`align="start"`). Detail pages and the portal's content column take the `Container` default (1280px, were 1152 and 1200). The table column keeps 1536px as the one override. This is the board parity rule applied to widths: AURA's sizes win over the boards' pixel values. Applied with the move onto AURA `Container` (PR B, AURA 5.28, 2 Oct), together with the e2e width bands in `layout/container-widths`, `layout-consistency`, `portal-layout` and `manual-qa`; the 672 / 1152 / 1200 figures above are superseded. The form pages ask `FormContainer` for `align="start"`; the `*_FORM_COLUMN` constants are gone. The page gutter (`--page-padding-x`) moved to AURA Container's steps, 24px from 640 instead of 768 (maintainer, 2 Oct, after comparing the two at 700px), so our padding and AURA's never disagree; only the 640–767px band changes (16 → 24px).
  - **The new-invoice Back button stays where it is.** It is a secondary header button on desktop, and below 1024px the shell's back link replaces it, as on the member pages (US5a). The board's link above the h1 is not followed.

### Session 2026-10-02 (US8b start, decided from the boards)

- **The detail layout follows `Admin-voided`**, the one board drawn in the agreed layout: "Invoice {number}" with the status pill; a Details card with the fields in a grid and the totals (subtotal, VAT, total) right-aligned at its end; then each further section in its own card. The order is Details, Payment details, Voided, Credit notes, Line items, Payment activity. The alerts (no primary contact, email delivery failed, auto-refund failed) sit above the Details card, as on `Admin-invoice-manager`.
- **The phone action bar is the header's own actions**, moved to the bottom of the screen below 640px with the total (incl. VAT) and due date above them. They are not drawn a second time, so every action keeps one trigger and its test id. Void leaves the bar for the ⋯ menu.
- **AURA 5.29 lands in this PR** (handoff #134, shipped): the list skeletons' rows match the real rows, and the renewals skeletons drop their own phone cards.
- **The heading's noun names the document by its type** (maintainer, 3 Oct, after the financial review): an 088 bill reads "Invoice {SC}", paid or not; the event-fee already-paid flow issues no bill, so its combined document reads "Tax invoice/receipt {number}" (TIN buyer) and its §105 receipt "Receipt {RE}" (no TIN). TH/SV use the wording of the existing document-type labels. The breadcrumb stays the bare number.
- **Parity comments on the US8b page** (maintainer, 3 Oct):
  - **Form column:** the void and new-credit-note forms ask `FormContainer` for `align="start"`, as every staff form does (the 2 Oct width decision); they had stayed centred.
  - **Button icons:** Void invoice carries `archive` (board `Admin-void`) and Delete draft… `trash-2` (board `Admin-invoice-issue`), both added to the § Button icons destructive list. The Issue confirm carries `check` and the refund confirm `rotate-ccw`. Dialog openers ending in "…" carry none. The draft header keeps the `Admin-invoice-draft` order (Preview, Delete draft…, Issue…), where the issue board draws another.
  - **Confirm labels name the amount:** "Issue invoice · {total} THB" ("Issue tax invoice · …" for a §87 tax invoice) on a membership bill and an event fee alike, and "Refund {amount}" once the amount is valid. The Issue dialog's summary and confirm are priced by the issue use case's own `computeIssuePricing` for the VAT treatment the admin picks, so a zero-rated §80/1(5) event fee reads VAT 0 and a VAT-inclusive event draft reads its line sum (VAT carved out), the figures the issued bill carries. A draft that cannot be priced (no invoice settings) names no amount.
  - **Refund help and summary:** the help line reads "Up to {amount} (paid, less refunds and credit notes)…", which also drops the doubled "THB" on `main`. A valid amount shows the refund total and what stays refundable afterwards. The board's VAT split rows ("Credit note to be issued": amount excl. VAT, VAT 7%) are not drawn: they need the server's proportional credit-note VAT policy and the §105 waived decision on the client, so they wait for their own change with a financial review.
  - **Phrase chips:** the phrase a typed confirmation asks for sits in its own chip with a copy button (refund, void), below the input and in its description; void reads "Type the invoice number to confirm" for an 088 bill ("Type the tax invoice number to confirm" for a §87 tax invoice). The phrases and their compares are unchanged.
  - **EN says "invoice", not "bill"** (maintainer, 3 Oct): the 088 SC- ใบแจ้งหนี้ is titled "ใบแจ้งหนี้ / Invoice" on its PDF and sits under the "Invoices" menu, so every EN string that names it says "invoice" (Issue and void labels, the list's "Invoice (SC)" filter, renewal-queue dialogs and toasts, renewal and void copy). Where a string must tell the two apart, the §87 ใบกำกับภาษี reads "tax invoice", never plain "invoice". Verbs ("bill the new plan"), the "Bill to" buyer legend and the "Bill first" issuance mode keep "bill". TH (ใบแจ้งหนี้) and SV (faktura) were already consistent and are unchanged; i18n key names (`issueBillButton`, `confirmCopyBill`, …) keep their internal `bill`.
  - **Refund settling:** an AURA info alert above Details says how much is settling (the pending refunds' total) and that nothing is needed (board `Admin-refund-settling`). The disabled actions keep their reasons as descriptions only, at every width, because drawn beside the buttons they squeezed the h1. Refund settling… carries the board's loader icon.

### Session 2026-10-03 (US8c start, decided from the boards)

- **US8c is two PRs** (maintainer, 3 Oct): **US8c-1** the credit-notes list and detail and the tax-document registers, with AURA 5.30; **US8c-2** the invoice settings, after which the full local e2e checkpoint runs.
- **AURA 5.30 lands in US8c-1** (handoff #135–#137, shipped): the issue dialog's zero-rate radios, certificate fields and typed phrase take `touchHeight="always"` (the 5.29 stand-in goes); menus stay with their trigger on scroll (the e2e retries go); status pills are weight 500. 5.30 colours checked controls with AURA's violet, not the brand accent, and `aura-theme` doesn't emit the token, so a hand-written override points them at the brand accent until AURA #139 (Addendum 42; maintainer, 3 Oct).
- **Credit-notes list follows `Admin-credit-notes`:**
  - the search and fiscal year on the shared filter bar, pushing `q` and `fy` as today;
  - a count line ("{shown} of {total} credit notes…") with the Refund legend;
  - columns Number (with the Refund chip), Issued, Original receipt (receipt number, bill or document kind under it), Member, Reason, Total, and a PDF download icon button. The number opens the detail, so the separate View button goes;
  - on a phone the rows become cards (the US7a rule). Download PDF, the list's only action, is a 44px icon at the card's top right beside the number, not a footer row (maintainer, 3 Oct; the board has no phone design).
  - **Not followed:** the board's Export CSV button (there is no credit-note export; adding one is a feature) and the sortable headers (the list has never sorted).
- **Credit-note detail follows `Admin-credit-note-detail`:**
  - "Credit note {CN-…}" with the Refund chip when it came from a refund; the always-the-same "Issued" badge goes (a credit note is immutable once issued);
  - Resend email and Download PDF become header buttons in place of the ⋯ menu (the resend request, its toasts and the 5-minute re-enable unchanged);
  - a Details card (member, issue date, issued by, original receipt) with the amounts at its end (credit excl. VAT, VAT, total), then Reason and Parties cards; Parties says resend goes to the member's current primary contact (108).
  - **Kept from the code:** the sibling credit notes, both language versions of the issuer's name and address, and the no-primary-contact banner.
  - **Not followed:** "Still creditable on the receipt" (the page has no such figure; computing it is money logic, not a UI swap).
- **Tax-document registers follow `Admin-invoice-registers` and its states:** the register, From and To fields with View register; the period output VAT box above the table with no footer (Session 2026-10-02); the summary line; cancelled receipts struck through with a Cancelled badge; on a phone the rows become cards and the box's note folds under "About this figure". The registers have no CSV export, so "the export equals main" (user story 8) means the row count, the cancelled count and every total, which the view test asserts against the use case's output; US8a's invoice export is untouched. The board's "Proposed" chip is an annotation, not product copy.

### Session 2026-10-03 (maintainer, US8c-2 start)

- **AURA 5.31 lands in US8c-2** (handoff #138 and #139, shipped; maintainer, 3 Oct: "Aura แก้ Hand off ให้แล้ว"):
  - `aura-theme` now emits the checked-control colour from the brand (light `#2e6397` with a white mark, dark `#9cc5f1` with an ink mark). The theme file is regenerated, and the US8c-1 hand-written override and its test go.
  - The typed-phrase chip moves into the TextField's `labelAddon`, between the label and the box, on the void page and in the full-refund dialog (boards `Admin-void`, `Admin-refund-full`). `labelAddonDescribes={false}` keeps the copy button's name out of what is read for the input; the chip's id still opens the input's description. What has to be typed, and how it is compared, are unchanged.
- **The invoice settings follow `Admin-invoice-settings`** (1440 only; the phone layout follows the US5b-2 form rule):
  - the page header "Invoice settings" with its subtitle;
  - the note "Changes apply to future invoices only…" as an info alert above the form. On a first-ever load it reads the existing first-time copy ("No settings yet…"). The legacy wrapper card and its "Invoice configuration" title go: the board has no such card.
  - a "Settings sections" rail (Organization, Tax, Document numbering, Document notes, Payment, Branding). The current section is marked, and a pick moves focus to the section's card, which is labelled by its heading (today it moves to the heading itself). Below `xl` the rail becomes a labelled "Jump to section" select (UX review: at 1024px beside the staff sidebar the cards would be too narrow for two field columns).
  - one card per section, titled with the section's name. The fieldsets inside each card (Currency, Tenant legal identity, Seller branch (§86/4), Prefixes, Invoicing defaults, and so on) keep their legends.
  - every field keeps its id, label, hint, length limit and character counter, on AURA fields;
  - a sticky bar once the form is dirty: "You have unsaved changes · Discard · Save settings". Discard is a ghost button at the bar's start, away from Save (UX review).
- **Discard is added** (maintainer, 3 Oct: "Add Discard"). It puts every field back to the values the page loaded with, the same snapshot the dirty check compares against. It clears the field errors and the error line, sends no request, and the bar hides. Focus moves to the first section's card. It is disabled while a logo upload runs, and from a successful save until the saved values arrive, so it can never bring back the values from before the save (financial review). A logo uploaded since the last save is dropped from the form; the upload itself is not undone (nothing references an unsaved key).
- **One Save at a time** (maintainer, 3 Oct, after the UX review): the form's own Save ("Save settings", or "Create settings" on a first-ever save) shows while nothing has changed; once the form is dirty the bar's Save takes over as the form's submit button, so Enter still submits and no two buttons share a name. The bar's Save reads "Create settings" on a first-ever save too.
- **The 44px targets stay** (088 FR-036): the seller branch code, the prefixes and receipt mode, the bank text fields, the rail, and the Save buttons. The fields use AURA's `touchHeight="always"`.
- **Unchanged:**
  - the logo upload request;
  - the PATCH body, its eleven client guards, and the error routing with its focus rules;
  - the prefix-change confirmation, which moves to the shared confirmation dialog with the same copy;
  - the success toasts and the refresh;
  - the leave-page guard.
- **Who sees the page:** only super_admin can open it (`settings.invoicing` is super-admin-only). The "manager read-only" comments are stale and are corrected. The read-only rendering stays in case the permission widens.
- **Not followed:** nothing. The board shows only headings and the bar; every field it omits is kept from the code.

### Session 2026-10-06 (maintainer, US9 start)

- **US9 ships as three PRs** (maintainer, 6 Oct: "3 PRs"), as US7 and US8 did:
  - **US9a**: the events list and the event detail page (boards `Admin-events`, `Admin-event-detail`, each with `-mobile`, and `Admin-state-events-no-integration`, `Admin-state-events-waiting`).
  - **US9b**: erasure and CSV import (`Admin-event-erase`, `-erase-page`, `Admin-events-erasure`, `-erasure-confirm`, `Admin-events-import`, `-import-result`, `-import-history`).
  - **US9c**: the EventCreate integration page under settings (`Admin-eventcreate`).
- **The erasure evidence log is US10.** `Admin-erasure-log` and `Admin-state-erasure-breach` sit under Compliance, not Events.
- **The events list follows `Admin-events` and the list rules** (docs/aura-adoption.md § List card, § Filters):
  - the page header "Events" with "Erase by email" and "Import CSV" (primary), each shown only to the roles that see it today. On a phone "Erase by email" moves into a "More actions" menu (`Admin-events-mobile`).
  - one list card holding the filter row, the table (or an empty state, or the load error) and the pager.
  - the filter row on AURA's `FilterBar`: the search, then three toggle chips (Counted as partner benefit, Counted as cultural event, Show archived events), and the result count at its end. The board's Search button goes: the search filters as you type, as every migrated list does. The count keeps today's wording, which names the search ("5 events for "midsummer""). It is the bar's polite live region, so the separate hidden live region goes. The URL parameters stay the same; as on every migrated list, a filter change writes them in place (`router.replace`), so Back leaves the list instead of replaying each search. The attendees filters on the detail page do the same.
  - the table columns Date, Name (with an "Archived" badge), Category, Registrations, Partner benefit, Match rate. The match rate shows its band word ("Strong", "Fair", "Weak") beside the percentage, as the board draws it; today the word is read only by screen readers. Below 640px each event is a card.
  - the four empty states (no integration, waiting for the first delivery, all archived, nothing matches the filters) on the shared AURA `EmptyState`. Their copy and links are unchanged: the waiting state already has "Send a test event" and "View integration settings".
- **The event detail follows `Admin-event-detail`:**
  - the summary card: date and category, the partner and cultural badges, the match-rate figure with its band word, total registrations, last updated, and "View on EventCreate";
  - the flag buttons and "Archive event" at the card's end, each confirmed in the shared confirmation dialog with today's copy. On a phone they move to an "Event actions" section at the page's end.
  - the attendees section: search, "Show unmatched only", the payment-status select, the table (Attendee, Match, Ticket, Quota, Registered, actions) and the pager. "Relink" opens the relink dialog, now on AURA `Dialog` with a server-searched `Combobox` instead of the legacy command list.
  - the match and quota badges in the board's tones.
  - the row's "More" menu, which holds "Erase personal data" on the board, comes with US9b, when the erase dialog moves to AURA. Until then the erase button stays beside "Relink", and "Relink" stays on every row as today (the board shows it only on rows that are not verified, which would remove the relink of a wrong verified match).
  - the payment-status select follows the filter pattern: a compact `FilterSelect` ("Payment status: All"), and an applied search or status is a removable chip in the bar.
- **Kept from the code where the boards are silent or wrong:**
  - the CSV column remap stays in US9b. The import board shows only which columns were detected, but removing the remap would remove a feature (FR-011).
  - the erase-by-email count stays the erasable count: the phone board's "Erase all 3 matches", beside a row already erased, is a board error.
- **The event-create date and time fix ships first, as its own PR, before US9b** (FR-011). The inline "create event" form converts its `datetime-local` value in the browser's time zone, while its copy promises the tenant's. US9b then puts the field on AURA `DatePicker` and `TimePicker` in Bangkok time.
- **Unchanged:** every server read, permission check, URL parameter, request body, toast and audit event on these pages, and the erase and payment-status guards in the attendee table.

### Session 2026-10-06 (maintainer, US9b start)

- **US9b ships as two PRs.** US9b-1 is erasure (`Admin-event-erase`, `-erase-page`, `Admin-events-erasure`, `-erasure-confirm`). US9b-2 is the CSV import (`Admin-events-import`, `-import-result`, `-import-history`), with the inline create on `DatePicker` + `TimePicker`.
- **No typed "ERASE" phrase.** Both erase dialogs are gated today by a required reason (1–500 characters). Adding a phrase would change behaviour inside a UI-swap PR (FR-011), so the dialogs keep the reason gate. If a phrase is wanted, it ships as its own PR.
- **The attendee row's "More" menu lands with US9b-1.** It holds "Erase personal data" as on `Admin-event-detail`; "Relink" stays on every row.
- **One name for the action in English:** the erase trigger and its confirm read "Erase personal data" (was "Erase PII"), matching the new menu item and the TH/SV copy, which already said "personal data" (UX review).
- **Parity pass on the erasure screens (6 Oct, maintainer asked Claude to decide; board wins on content, structure and icons):**
  - the result count shows beside "Erase all" in a tinted band, as the board draws it; a zero count stays a screen-reader status, because the quiet "No registrations found" line already says it. The board's "· 1 already erased" is not drawn: the email search never returns an erased row (its email is a salted hash).
  - "Back to events" and "Back to event detail" are accent links with a left arrow, shown from `lg`; below it the shell's back link does the same (the US8b void page pattern).
  - on phones, Search and "Erase all" fill the width.
  - the reason field in both erase dialogs is marked required (the gate is unchanged).
  - the deep-link erase page has no card: the hint is the page subtitle and the two actions sit under it. A card frames a group of content; here there is one sentence and two actions, and the void page puts its description in the subtitle the same way.
- **Kept as found in US9b-1, fixed in the follow-up PR right after it (logic changes, FR-011):**
  - the deep-link erase page's hint says the dialog opens automatically, but it does not. Fixed: the dialog opens on arrival, and a successful erase sends the admin back to the event (the erase deletes the registration, so the old refresh landed on a 404);
  - the erase action shows to staff who can relink, while both erase routes need the super-admin `events.erasure` permission, so a plain admin's submit is refused. Fixed: the row's erase menu shows only with `events.erasure`; Relink stays on `events.relink`, so a super admin can also erase on an archived event (the routes allow it). No new error copy: the F6 guard answers a plain admin with 404 by design, so hiding the action is the control.

### Session 2026-10-09 (maintainer, US9b-2 start)

- **US9b-2 is one PR:** the import page (mapping form, event picker, inline create, mismatch warning, result) and the history page.
- **The file field is AURA `FileUpload`, given no `maxSize` or `accept`.** With either, `FileUpload` turns a rejected file into an error item and never hands it on, so a file over 5 MiB would lose today's error panel and its copy. The 5 MiB check and the header parse stay in the form (FR-011).
- **The column remap moves to AURA `Select`.** Labels, options and the mapping sent to the server are unchanged. Tests pick through the combobox and option roles instead of a native `<select>`.
- **The event picker moves to AURA `Combobox`, filtering locally.** The fetch, the filename suggestion and the separately kept newly-created events are unchanged. Each option reads "name — date", so the closed field still shows the date. The "+ Create new event" button inside the empty list goes, because the Combobox empty text is text only. The "Create new event" button under the field stays, so nothing is lost.
- **The inline create's start is two fields:** "Start date" (`DatePicker`, Bangkok time, Buddhist Era on TH display only) and "Start time" (`TimePicker`). They feed the same `bangkokInputToIso` conversion, so the instant sent is unchanged.
- **The CSV preview stays a semantic table** with sticky headers in both directions, restyled with AURA tokens. It previews raw file rows, not records, so `DataTable` does not fit.

### Session 2026-10-09 (maintainer, US9b-2 parity, decided on the parity page)

- **The import screens follow the board** (comment "เอาตามบอร์ดดีไหม"; form and result card both). Each change is layout only, on existing handlers and state (FR-011).
- **Import form:**
  - the card is capped at about 720px (45rem);
  - Cancel comes before Confirm, both at the end of the row; on phones they stack full width, Confirm on top;
  - Event is marked required and gets a clear ×, which returns to the existing "no event" state with Confirm gated;
  - the refresh button sits beside the field, and "+ Create new event" is an accent text link;
  - the chosen file stays where the upload field was, as a row with "Change", which uses the same reset as Cancel;
  - required columns that are present become filled green chips.
- **Result card:**
  - the counters are tiles;
  - the reference ID, the error-CSV download and a primary "Upload another CSV" sit in the card footer (on phones: the ID, then the primary action, then the download);
  - the error disclosure has a neutral frame.
  - Not done: the board's "Open event" button and its footnote (new content), and the "Before you import" summary (it needs a dry run the server does not have).
- **History** (comments "ช่องว่างเยอะไปไหม", "ตรงนี้ใช้ Consist เหมือนหน้าอื่นไหม", "ปุ่มนี้แก้ไหม"):
  - the list-card rule and the shared `TablePagination`, as on Events, Members and Invoices, with the same `?page=N&perPage=M` URLs;
  - the auto-refresh line takes no room while nothing runs, and stays a mounted live region;
  - phone cards follow the board: date and file, the outcome pill, one summary line ("EventCreate · 146 processed · 2 skipped · 3 failed", a new EN/TH/SV string), and a full-width download only when there is one;
  - the grid's download is a bare icon button;
  - "Back to import" hides below 1024px, where the shell's back link does the same (the erasure page's rule).

### Session 2026-10-09 (maintainer, US9c start)

- **US9c is one PR:** the EventCreate integration page (`/admin/settings/integrations/eventcreate`) and its loading and error files. Boards `Admin-eventcreate` and `Admin-eventcreate-mobile` draw only the configured state (step 3); the fresh-secret, one-time reveal and Zapier steps follow the same parts by analogy.
- **Unchanged (FR-011):** the flag and permission guards, the config read and its `?includeTestDeliveries` URL, the generate / rotate / test requests with their 409 and 429 branches, every toast, the wizard's step order, the one-time reveal with its "I've saved this secret" gate, the 2-second test cooldown and the clipboard fallback.
- **The steps are AURA `Stepper`,** driven by the current step, so earlier steps show as done. Below 640px it shows only "Step 3 of 3 — Test & manage", as the mobile board does.
- **Webhook URL and current secret are read-only value boxes** (mono, tokens) with their label above, as on the board: copy beside the URL (the existing AURA `CopyButton`), "Rotate secret" (secondary, `rotate-ccw` icon) beside the secret, full width under it on phones. AURA has no secret field, so the one-time reveal is the same value box with eye / eye-off and copy `IconButton`s, and the "saved" gate is AURA `Checkbox`.
- **"Send test event" is a secondary button without an icon** (board); while it runs it shows AURA's loading spinner and the same "Sending test event…" text.
- **"View setup guide" stays a native disclosure,** drawn as the board's bordered row with a chevron; the walkthrough still renders only while it is open.
- **Recent deliveries:** the heading, then the "Include test deliveries" `Switch`, then the rows. Signature is a status pill (Verified → ready, Signature rejected → blocked, Unknown → neutral); processing is plain text, as on the board. On phones each row is the time with the pill beside it and one line "processing · request ID". With no rows, the existing empty text.
- **The grace banner and the "old secret still verifies until" chip** (no board) become an info `Alert` (`role=status`) and a `Badge`.
- **`ui/stepper.tsx` loses its last consumer** but stays until US13 removes `src/components/ui/`. The error boundary moves to the shared `RouteErrorPanel`, as the import history page did.

### Session 2026-10-12 (maintainer, US10 start)

- **US10 ships as three PRs:** US10a the users page (list, filters, change-role and invite dialogs, and the member picker the invite uses); US10b the audit log and the compliance erasure log; US10c the settings hub, member-change approval settings and the staff account page.
- **The broadcast settings pages** (`/admin/settings/broadcasts` and `/brand`) **are US12**, not US10: they are built from the E-Blast components US12 migrates.
- **Users list (board `Admin-users`, `-mobile`):** every row, a desktop table row or a phone card, has one primary action (Change role, else Resend invitation, else Enable) and the remaining actions in a ⋯ `Menu`. The board draws inline buttons on desktop; relay R42 showed three of them wrapping at 1280 (rows 57–89px against Plans' 48.5px, SC-013), so the maintainer moved desktop to the phone pattern (2026-10-12). Below 1280px the desktop row button shows its icon alone, with its name and tooltip kept, and the status pill and the invitation expiry share one line. On phones each row is a card with the name, status pill, email, role badge and expiry, one primary action full width, and the remaining actions in a ⋯ `Menu`; Disable and Revoke are AURA danger items in the menu on both, and every destructive action still opens the existing confirmation dialog (the US10 acceptance scenario). "That's you" stays on your own row.
- **Unchanged (FR-011):** the page and action permission checks (`users.member_accounts`, `users.manage`), the `?q`/`role`/`status`/`page` URL, every request (invite, change role, disable, enable, resend, revoke) with its toasts, the 404/409 stale-row refresh, the 429 resend wait, the self and last-admin rules, the typed PROMOTE confirmation for Super Admin, and the invitation-expiry hint computed on the server.
- **Filters follow the one filter pattern** (docs/aura-adoption.md § Filters): `FilterBar` with the search, then Role and Status `FilterSelect`s, the result count and a chip per applied value.
- **Change role (board `Admin-user-role`):** AURA `Dialog role="alertdialog"` with a labelled `RadioGroup` (each role with its description, "(Current)" on the current one), the member-portal note, the Super Admin warning as an AURA warning `Alert` and the typed confirmation as an AURA `TextField`.
- **Invite (board `Admin-user-invite`):** AURA `Dialog` with the email `TextField`, the role `Select` and the member link. The role's summary moves from inside each option to a hint under the select (same words; AURA's select lists one line per option). The board marks the member link required, which would change what the form accepts, so it stays optional (FR-011, a board deviation).
- **The member picker moves to AURA `Combobox`** with server search (`onSearch`), as the relink dialog did. The invite dialog is its only consumer (the E-Blast proxy compose has a picker of its own), so it takes a `label` and `hint` like any AURA field instead of `aria-labelledby`; the request (`/api/members?limit=20&status=active&q=`, 200 ms debounce), the clear and the load-failure line are unchanged. It loads the first 20 while it is enabled rather than when its list first opens: the same request, earlier.
- **Decided while building US10a:** the search box sends what was typed and the page trims it (as on Invoices), because AURA's FilterBar compares the URL back against what it sent and a trimmed value would rewrite the box mid-typing. The current role is named in its option ("Admin (Current)"), as the board draws it. A pending row with no name yet says "Invitation pending — no name yet" on its phone card (the board's line). The super_admin badge keeps its shield icon (a non-colour cue). The users list uses AURA's static `Table` rather than `DataTable`, because its rows carry the `data-user-*` attributes the session e2e relies on, which DataTable rows cannot.
- **US10a review follow-ups (2026-10-12):** the dialog fields take AURA's `touchHeight` (44px on phones). Two AURA gaps stay open for the handoff doc: the FilterBar search and `FilterSelect`, and the `Combobox`, reach 44px only on a coarse pointer (real touch phones are fine); below 640px with a mouse they are 36px beside 44px `touchHeight` fields and buttons (#140, #141). Two phone-board placements follow the shared patterns rather than the board: the result count sits at the end of the filter row, and the header's Invite button takes the PageHeader's full width on phones. Focus after cancelling a confirmation or the change-role picker returns to the button that opened it (for a phone card's menu item, that card's ⋯ button); after a confirmed action it goes to the page landmark, since the row may refresh away (maintainer request, 2026-10-12).

### Session 2026-10-16 (the invoice phone bar on AURA's PageHeader, #149, #150)

- **The invoice page's phone bar is AURA's** (maintainer, 16 Oct). The header passes `actionsBarBelow="sm"` and `actionsStatus` (the total incl. VAT and the due date) through the page-header wrapper. The wrapper passes `actionsFullWidthBelow="sm"` with it (AURA 5.48 lays out the actions by that prop on a short screen; at a normal height the bar's rules win). `InvoiceActionBar`, its height variable, its `scroll-padding-bottom` and the page's spacer are deleted: AURA pads the page end and keeps a focused field clear of the bar. Every action is still drawn once, keeping its trigger and test id. #149 and #150 close.
- **AURA's look ships for now** (parity rule): the bar is AURA's floating card, inset 16px from the screen edges. That is not ActionBar's look, which the prop's doc promises: the board and the app's nine other bottom bars (all ActionBar) are a full-width strip with a top border. So it goes to AURA as #153 (Addendum 55, maintainer, 16 Oct), with no override in the meantime. The status line is a polite live region.
- **AURA 5.48 adopted in this PR** (#153, #154). The bar is now ActionBar's edge strip by default (full width, top border), so it matches the board with no prop. On a screen 480px tall or less (400% zoom, 320×256 CSS px) the bar is no longer fixed: the actions return to the header's full-width row and AppShell's top bar scrolls away, so content keeps the screen (WCAG 1.4.10 / 2.4.11). The pin is 5.48.0.
- **The ⋯ is AURA's plain IconButton, found by AURA.** The menu loses its wrapping `span`, so the ⋯ is a grandchild of the actions, which AURA's bar can detect and keep at its own width, centred beside the actions. `data-slot="invoice-more-menu"` moves onto the button. It is plain at every width (maintainer, 16 Oct): the board draws it plain and no other ⋯ in the app is outlined, so the old phone-only border goes.
- **A known narrowing.** A bar with a total line but no action had shown only the total. Now the bar exists only when there is an action, so the total line rides with the actions. A manager on an issued invoice with no PDF yet sees no bar; the total is in the Details card.
- **The title number at a 32px default font** (R50, from #561). The number is an inline box (`inline-block max-w-full [overflow-wrap:anywhere]`, like the credit note's title). It still moves to its own line as a whole at 320px, and breaks inside only when it alone is wider than the line, so the page no longer lays out 435px wide at 390.
- **One `DocumentNumberHeading` for document titles** (maintainer, 16 Oct). The invoice and credit-note titles both render through `src/components/layout/document-number-heading.tsx`, so a fix lands on both pages. `tests/unit/architecture/document-number-heading.test.ts` finds every `PageHeader` whose title carries a number, requires the component, and refuses a no-wrap span round a number on those pages. Its positive control fails if the scan finds neither page. #547 had fixed the credit note, and #561 then reintroduced the same no-wrap number on the invoice.
- **AURA 5.49 (#155, Addendum 56), adopted in its own PR.** R51 measured the phone bar at about 232px tall at a 32px default font (27% of an 844px screen). AURA now writes #154's height thresholds in `rem` (30rem), so on Chrome, Edge and Firefox a phone at a large default text size counts as short: the actions sit in the header's full-width row, ActionBars are static, and the top bar scrolls away. At the default 16px nothing changes; iOS Dynamic Type does not move the threshold. The pin is 5.49.0.
- **The payment timeline's rows can shrink** (R51). With the title fixed, the paid invoice still laid out 405px wide at 390 with a 32px default font: a row's time · actor line ends in the actor's email, one unbreakable token, and its `flex-1` column had no `min-w-0`. The column gets `min-w-0` and the line `[overflow-wrap:anywhere]`.
- **The refund dialog's payment line drops no-wrap** (maintainer, 16 Oct). Its three chunks are invoice number, receipt, and amount with date. Each becomes an inline box (`inline-block max-w-full [overflow-wrap:anywhere]`), whole on its line and broken inside only when it alone is wider than the dialog. The same guard now refuses a no-wrap span round a document number anywhere in `src`, not only in page titles.

### Session 2026-10-16 (AURA 5.46–5.47 adoption; the page header on AURA PageHeader, #151, #152)

- **AURA 5.44.0 → 5.46.0, two PRs** (maintainer, 16 Oct). This one: the bump and the page header. `src/components/layout/page-header.tsx` is a thin wrapper over `PageHeader` with the same props, so its ~170 call sites are unchanged: `badge` → `titleAddon`, `autoFocusTitle` → `focusTitleOnMount`, `subtitle` / `meta` / `eyebrow` / `size` pass through, actions take the whole row below 640px (`actionsFullWidthBelow="sm"`), and the portal (rendered under `density="comfortable"`) top-aligns its actions (`actionsAlign="start"`). The root keeps `data-slot="page-header"` and `data-size`.
- **AURA's sizes ship** (maintainer, 16 Oct, the parity rule): the title is AURA's default (28 / 36px; hero 30px, hero-lg 26 → 36px) and a hero page gets AURA's 16px of extra room. The app's own title-size and hero-padding rules are deleted (a unit test keeps them out). The board sizes (26 / 32, hero 36 from 1024px, 24 / 40px above a hero title) are filed as #152 (Addendum 54); AURA 5.47 shipped them as `size="compact"` (26 / 32; the default stays 28 / 36 for other AURA apps), `hero` 30 → 36px from 1024px, and `--aura-page-header-hero-space`. The wrapper maps `default` to `compact`, and the portal sets the hero space to 4px (8px from 1024px), so the titles and the room above a hero title match the boards again (measured: 26 / 32px, hero 30 / 36px, hero title 24 / 40px down). The pin is 5.47.0.
- **Next PR:** the invoice page's phone bar moves to `actionsBarBelow` (see the session above).

### Session 2026-10-15 (AURA 5.44 adoption; #148 closed)

- **AURA 5.42.0 → 5.44.0, its own PR.** 5.43 ships #148: a `collapseBelow` bar with no search marks its lead row `is-alone` and the Filters button fills it on phones, so the timeline drops its stand-in and looks the same (44px, the full row). 5.44 ships #149 (`PageHeader actionsFullWidthBelow` keeps an IconButton on the actions' row) and IconButton `variant="outline"`; both are additive here, since Chamber-OS does not render AURA's `PageHeader` yet. The invoice phone action bar and #149/#150 are tracked with PR #561 (Addendum 52). The brand theme regenerates unchanged.
- **The page header moves onto AURA's `PageHeader`** (maintainer, 15 Oct): no app-owned header stays in the end state (the full-aura-react decision and Principle VI). `src/components/layout/page-header.tsx` keeps its props and becomes a thin wrapper over `PageHeader`, the way PR B moved the layout containers onto `Container`, so its ~170 call sites stay as they are. It cannot move yet: about 120 pages use a body-size subtitle, and the portal needs hero title sizes, which `PageHeader` lacks. Those gaps are filed as #151 (Addendum 53), and AURA is working on it. Until #151 ships the header stays as it is, with no stand-in. Then one PR swaps the wrapper's insides and checks parity against the boards at 390 and 1280 in light and dark; with #150 in the same AURA release, it also deletes the invoice page's own action bar (#561). Where AURA's title type differs from the boards (28 / 36px against 26 / 32), AURA's default ships, per the parity rule above: the board values go to the handoff as #152 (Addendum 54), never into an override (maintainer, 16 Oct).

### Session 2026-10-15 (mobile Filters sheet, #146)

- **Every list filter bar folds on phones** (maintainer, 13 Oct parity check; AURA 5.42 `collapseBelow`): all twelve AURA `FilterBar`s pass `collapseBelow="sm"`. Below 640px the search, applied chips, Clear all, the count and the actions stay in the bar, and the filter controls move into a "Filters (n)" sheet. From 640px nothing changes. A bar with only a search (erasure log) shows no button. An architecture test keeps the prop on every bar.
- **"More filters" popovers lay out flat in the sheet** (maintainer, 15 Oct): on phones the Invoices and Audit popover fields are the bar's own children, so the sheet lists them with everything else; from 640px the popover stays. The switch reads AURA's `useBreakpoint()`, which is `lg` on the server, so the server HTML is unchanged.
- **The timeline's own phone "More filters" toggle goes** (maintainer, 15 Oct): AURA's sheet replaces it, so the timeline behaves like every list. With no search beside it, its Filters button fills the row on phones (maintainer, 15 Oct; AURA's own rule since 5.43, #148).
- **The Filters button counts every applied filter:** AURA counts the chips by default, so a bar whose toggle is not repeated as a chip adds it (`filterCount`): the events toggles and the timeline fields (no chips at all), attendees "Show unmatched only", members "Needs portal invite", plans "Active only" / "Show deleted", invoices "Paid online" outside the tax view, and the member directory's "Listed only". The search is never counted: it stays in the bar (UX review, 15 Oct).
- **Clear inside the sheet keeps focus** (UX review, 15 Oct): a list's own Clear button sits in the sheet on phones and unmounts when pressed, so focus moves to the sheet's Done rather than the search behind it. The timeline's Clear shows on phones only once a filter is set, as before.
- **Filters keep their values with the page:** the sheet remounts the controls it moves, so the audit acting-user field becomes controlled (its typed value and the 300ms debounced URL commit live in `AuditFilters`), and a half-typed value survives the move. No URL parameter, request or chip changes (FR-011).

### Session 2026-10-14/15 (AURA 5.42 adoption; the mobile Filters sheet requested as #146)

- **AURA 5.39.0 → 5.42.0, its own PR** (maintainer, 14 Oct; 5.42 on 15 Oct skips the held 5.41 draft). 5.40 ships #145: AURA's type follows the browser's default font size (`max(<px>, <rem>)`), identical at the default 16px. 5.41 is additive (PageHeader `titleHideBelow`, `data-aura-hide-menubutton`, "opens in a new tab" on menu links, open menu triggers keep their hover fill); nothing in Chamber-OS uses those yet. The brand theme regenerates unchanged.
- **The mobile "Filters (n)" sheet is asked of AURA first** (maintainer, 14 Oct): no released `FilterBar` folds its filters on phones, so it is filed as #146 (Addendum 49) — below 640px the search, applied chips, count and "Clear all" stay in the bar, the other filters move into a sheet behind a "Filters (n)" button. Shipped in 5.42.0 as `FilterBar` `collapseBelow`; the mobile Filters PR adopts it on every list after this one.
- **Found adopting 5.41, filed as #147:** at a 32px browser default the `FilterBar` search overflows a 390px phone by 79px (its flex box keeps `min-width: auto` while the input's 20 characters now grow with the font). Shipped in 5.42.0 (`.aura-input` `min-width: 0`): at 32px / 390 no list scrolls sideways.

### Session 2026-10-14 (AURA 5.39 adoption, between US10 and US11)

- **AURA 5.31.0 → 5.39.0, its own PR** (maintainer, agreed at US10b: the upgrade lands before the mobile Filters PR and US11). 5.38–5.39 ship the US10 touch-height items: `touchHeight` on `FilterBar` (its search and every field-height control in it; #144 turned out not to be a gap — the 42px was the `<input>` inside the 44px box, AURA's status of 13 Oct), `FilterSelect`, `Combobox`, the date, time and number pickers (#141), `Tabs` and `FilterDateRange` (#143); DataTable `rowProps` (#142) is available and not needed. The brand theme regenerates unchanged.
- **Where the prop goes:** every AURA `FilterBar` and every `Tabs`; the pickers that sit beside 44px fields (member picker, event picker, relink dialog, reminder step card, inline event create). Forms whose other fields have no `touchHeight` keep the density default (44px on a coarse pointer), so a form never mixes heights. The legacy `ui/filter-bar` (E-Blast audience, US12) is untouched.
- **Still open, filed as #145 (Addendum 48):** AURA's type is set in px, so card and switch descriptions don't follow the browser's default text size (zoom still scales them).

### Session 2026-10-14 (US10c start)

- **The settings hub** follows boards `Admin-settings` / `-mobile`: one AURA card per visible category, two up from md and one column below. The whole card is the target: the title link stretches over it, so each card is one tab stop named by its title, with the icon in a tile, the description and a chevron. The visibility rules (`CATEGORIES`, `canPerform`, the flag map) are unchanged; with no settings surface the empty state sits in a card (board `Admin-state-settings-none`). The hub still has no `error.tsx`.
- **Member-change approval** (boards `Admin-settings-member-changes`, `-mobile`, `-off`): one AURA card titled "Approval requirement" holding AURA's `Switch`, which carries its own visible label and description (the separate `Label` goes; a click on the label text still toggles it). The pending note and the errors are AURA alerts with the same roles. The request, the toasts, the switch-off confirmation and "no optimistic flip" are unchanged; while a request is in flight the switch row is `aria-busy` and the switch is never `disabled`. `error.tsx` moves to the shared `RouteErrorPanel`.
- **The staff account page** (boards `Admin-account`, `-mobile`): the role is an AURA badge styled exactly as on the users list (one shared `ROLE_BADGE_STYLE`; super admin solid with its shield), and the form sits in one AURA card under its explanation. The board draws no second "Change password" heading inside the card, so it goes; the page h1 already says it. Decided with the maintainer on the parity page (14 Oct): the shared change-password form takes no required asterisks on either portal (the `Admin-account` board draws them, `Portal-account` does not; every field is required, as on the other password forms, and a missed field is named in the error summary), and its button is full width on phones and keeps its own width from sm up — at the end of the form on the staff page, at the start beside "Forgot your password?" on the member page, as each board draws it.
- All three pages keep their containers (`DetailContainer` for the hub, `FormContainer` for the other two), now start-aligned as the boards draw them.
- **Found in the preview (2026-10-14), fixed in this PR:** at 200% text on a phone the account email (no break opportunity) pushed the page 39px sideways; it may now break anywhere.
- **UX review (2026-10-14), no HIGH; fixed in this PR:** each hub card link is described by its description (focus reads both); the card focus ring uses AURA's ring width and offset tokens; the stretched hit area takes the card radius; the hub skeleton draws four cards, not six, since most roles see fewer.
- **Recorded, not changed here (behaviour or copy, unchanged from before this PR):** while a switch request is in flight a second toggle is ignored without a spoken "Saving…" (needs a new EN/TH/SV string); the change-password form has no programmatic name of its own beyond the page h1. AURA's switch description and card description are in px, so they do not follow the browser's default text size (an AURA handoff item for the upgrade PR).

### Session 2026-10-13 (maintainer, US10b start)

- **The audit filters follow the one filter pattern** (docs/aura-adoption.md § Filters), not the board's five labelled fields: Target record is the bar's search, Event type a `FilterSelect` keeping today's category groups, Actor a labelled text field in the bar's "More filters" popover (AURA has no compact free-text filter besides the search, and a `TextField` always shows its label above the box), and From–To one `FilterDateRange`. Every applied value is a removable chip, the bar carries the count and "Clear all", and the URL parameters stay the same. The board's phone "Filters — None applied" row is not used: the chips wrap, as on Members. The board's phone "Filters" button is wanted (maintainer, parity comment 13 Oct) but for every list at once, not audit alone: a separate PR after US10c and the AURA upgrade puts it on all list pages — on phones the search stays visible, the other filters move into a "Filters (n)" sheet, and the applied chips stay visible; desktop is unchanged.
- **The audit table** stays AURA's static `Table` (cards on phones), because its pagination is first/previous/next links over a cursor, not numbered pages. The board's retention line goes under the table, worded to match the data (privacy and i18n review, 2026-10-13): "Audit records are kept for at least 5 years; tax-document and payment records for at least 10 years." (EN/TH/SV). The board's "tax-document events for 10 years" left out the payment and refund events that `F5_AUDIT_RETENTION_YEARS` also keeps 10 years, and nothing purges `audit_log`, so both figures are minimums.
- **The erasure log:** the status filter becomes AURA link `Tabs` with counts; an inactive Overdue tab keeps its warning icon but not the red text, as the board draws it. The search is the AURA `FilterBar` search, as on every other migrated list (maintainer, parity comments 13 Oct): no Search button and no visible label — its name "Search by member number" is read out, the hint "e.g. SCCM-0042" sits in the box, and its own × clears it (the separate "Clear search" link goes). It searches 300 ms after typing stops and at once on Enter, writing the same `?status=…&q=…` in place (`router.replace`). The all-clear notice stays though the board does not draw it, since dropping it would change what the page reports.
- **Found by R43 (2026-10-13), fixed in this PR:** the Event type options are sorted in the UI locale. The AURA `FilterSelect` renders every option on the server, and a sort in the runtime's default collation ordered them differently on the server (th-TH) and in the browser (en), so `/admin/audit` failed hydration. The erasure search bar's region keeps AURA's own name, so the search's name is read once.
- **Found in the preview (2026-10-13), fixed in this PR:**
  - AURA wraps a `Card`'s children in its body, so the audit card's spacing sits on a wrapper inside it.
  - On phones, Export CSV, the pager links and "More filters" get 44px boxes (`touchHeight`).
  - Below 640px the audit list follows board `Admin-audit-mobile` (maintainer, parity comments 13 Oct): one compact card per event — time · HH:MM UTC, the event, "Target: …" when there is one, the summary, and "by {actor} · label: value". The table from 640px up keeps every column (raw codes, actor and target ids, the ISO instant). New EN/TH/SV strings `admin.audit.table.cardTarget` / `cardBy`.
  - The breadcrumb on `/admin/audit` read the raw slug "audit"; it now reads "Audit log" (EN/TH/SV, the nav's own label).
  - The evidence card follows the board's layout: a bold title, the request and completion fields three-up on wide screens, and a rule between sections. The sub-processor block stays 2×2 (its Round 4 L10 decision: four fields, stable height).
- **Kept against the board:**
  - The evidence card's half-run note stays an AURA `Alert` (warning, or danger when overdue); the board draws plain text. Its `role` is unchanged. It is a reportable-breach line on a compliance surface, so the emphasis stays unless the maintainer decides otherwise.
  - The evidence card keeps the login-credential and tax-document sections when they are empty (the board leaves them out): a DPO answering a request needs "none recorded" stated.
- **UX review (2026-10-13), fixed in this PR:**
  - A hand-typed bad date (`?from=2026-02-30`) still gets a chip and "Clear filters". The chips used to read only valid dates, so the invalid view had no way out but a retry of the same URL.
  - The acting-user field is no longer remounted by its own commit, so it keeps focus and a trailing space. Only a chip × or Clear resets it.
  - The invalid-filter state follows board `Admin-state-audit-invalid`: the filters and a danger alert (same title and field-naming text, `role="alert"`) share the list card, and the "Try again" button is gone because it reloaded the same URL.
  - A from-after-to range shows its two days rather than one reversed range.
  - The erasure loading skeleton matches the 44px search box and the three-up grid.
  - "Clear filters" no longer remounts the filter bar, so its live count stays mounted and announces the new count (L4). AURA's own Clear button already drops the search draft and its pending debounce.
- **AURA gaps (handoff #143, #144):** in 5.31 the erasure status `Tabs` links and the FilterBar's `FilterSelect` / `FilterDateRange` are 36px with a mouse; on a touch screen they already measure 44px. The FilterBar's own search input is 42px even on a touch screen (R43; every list that uses it). The load-error card's "Try again" (shared `DashboardErrorState`, not in this PR) is 32px on phones.

### Session 2026-10-16 (US11 start: the staff dashboard)

- **One PR** (maintainer, 16 Oct). Boards: `Admin-dashboard`, `Admin-dashboard-mobile`.
- **KPI tiles are AURA `Stat`s** with the board's icons (users, circle-check, triangle-alert, trending-up) and captions. The animated count (`CountUp`, with its single screen-reader copy) is the tile's value. `KpiCard` goes. The grid rules are unchanged: four up with finance, three without.
- **Needs attention counts are pills** (maintainer, 16 Oct, as the board draws them): an AURA badge beside each row link. The numbers and links are unchanged. The unavailable row is an AURA danger alert, keeping its `role="status"` and test id.
- **The charts keep recharts** (this spec's assumption: the charting library stays) behind a dashboard-local chart frame that replaces the legacy `ui/chart`. The colours move off the token bridge onto AURA's chart tokens:
  - bars, areas and lines: `--aura-chart-1` (the brand theme sets it to the brand blue in both themes);
  - grid and reference lines: `--aura-chart-grid`;
  - axis text: `--aura-chart-axis`;
  - the invoice donut: semantic tones for paid, unpaid and overdue (`--aura-fg-positive`, `--aura-alert-warning-fg`, `--aura-fg-danger`), with the cell gap in the card colour;
  - the delta chip: positive and danger tones instead of Tailwind emerald and red.

  A unit test keeps the bridge names (`--primary`, `--chart-N`, `--success`, `--warning`, `--destructive`, `--border`, `--card`) out of the dashboard components, so nothing silently depends on the bridge that US13 removes.
- **Not drawn: the board's per-insight "View" link.** An insight carries no target (`{ key, count, scopeRef? }`), so a link would be new behaviour (FR-011). Dismiss stays as it is.
- **Unchanged (FR-011):** the guards and flags, the five loaders, every server- and client-side format, every href, the optimistic insight dismiss and its toasts, the activity refresh, the screen-reader chart tables, the reduced-motion handling, and the client-only chart loading.
- `DashboardErrorState` stays shared; the E-Blast portal panel (US12) also uses it.
- **Card titles are headings now.** Each panel and chart card is an AURA card titled at h2 (the legacy card title was a `div`). They take AURA's card-title size, so the SC-010 typography e2e treats an AURA card title as AURA-owned instead of asking for the FR-017 `text-h2` step.
- **Refresh uses AURA's `loading`.** While the feed refreshes, the button shows AURA's spinner, sets `aria-busy` and ignores clicks, so there is still one refresh at a time. It is not `disabled`, so focus stays on it.
- **Needs attention rows follow the board** (maintainer, parity page, 17 Oct). Each row is one link: the destination's nav icon, the label, the count pill and a chevron, between AURA dividers, and at least 44px tall. The overdue-invoices pill is a solid danger badge. Labels, counts and links are unchanged.
- **More board parity (maintainer, parity page, 17 Oct):**
  - **KPI tiles two up on phones**, as the mobile board draws them; with three tiles (no finance) the third spans the row.
  - **The phone revenue tile shows a compact amount** ("THB 381K", three significant digits, as the board), because the half-width tile cannot fit the full amount (16px over at 390, 31px at 360). Screen readers and every width from 640px keep the exact amount.
  - **The trend charts carry the board's axes**: taller canvas, a value axis from zero with compact ticks, horizontal grid lines, short month labels, and the current month's bar drawn lighter. The old max line and first/last month row go. The baseline stays at zero on member growth (the board starts at 90), so the filled area stays proportional.
  - **Membership by tier follows the board as plain rows**: label, a track with the bar, then "count (pct)". No canvas and no hover tooltip on this card (the values are printed). The headline total and the percent stay (FR-011).
- **Kept, not drawn from the board (parity page, 17 Oct):** no chevron on phone insights, because an insight has no destination.
- **Invoice status follows the board, in its own PR after US11** (maintainer, 17 Oct). The card shows the exact total, one stacked bar sized by each bucket's satang share, and a row per bucket with its amount and percent. The recharts donut goes. Every figure was already computed for the hidden table and the old tooltip.
  - The figures review (financial-reporting-analyst) found that whole-baht rounding can leave the rows ฿1 off the total. The maintainer chose two decimals for this card only; money is never redistributed to make it add up.
  - A non-zero bucket under 1% reads "<1%".
  - The description now says the figure is net of credit notes and refunds (EN/TH/SV); the "Total invoiced" label stays.
  - UX review (17 Oct), fixed:
    - the loading card reserves the title, the description (two lines on phones) and the two-line phone headline;
    - the headline breaks only at the currency space or after a thousands group, never inside a number;
    - each row keeps its amount and percent together.
  - UX review, kept on purpose:
    - Segment colours stay on the semantic positive / warning / danger tokens with a 2px gap. AURA defaults win on component colours (confirmed by the maintainer, 17 Oct, over the board's lime/blue/red); each segment measures ≥ 6.4:1 against the card; the rows carry text labels (WCAG 1.4.1).
    - The headline is read as value then label, the same order as every other hero figure on the page.
    - The empty state gets no new link to the invoice list, since that would be new behaviour (FR-011).
    - The description runs to two lines on phones (three to four at 200% text).
- Dashboard polish (maintainer, 17 Oct; same PR as invoice status). Layout and typography only, no figure or copy meaning changes:
  - Smart insights rows sit between dividers with a decorative dot, as Needs attention and the board draw them; each row is ≥ 44px.
  - Recent activity lines wrap instead of ending in an ellipsis, so a phone shows the whole line.
  - The trend cards' summary label ("Cumulative members", "12-month total …") takes its own line below 640px.
  - "ex-VAT" (EN, non-breaking hyphen) and "exkl. moms" (SV, no-break space) never split across lines.

### Session 2026-10-18 (US12 start: E-Blast)

- **Four PRs** (maintainer, 18 Oct). E-Blast is about 25k lines across about 110 legacy files, so it ships in slices. A component the member portal shares moves together with both of its callers.
  - **US12a:** broadcast settings (image allowlist, brand), templates, and the marketing audience.
  - **US12b:** the review queue, plus the shared reason-confirmation and typed-phrase dialogs (members and renewals use them too).
  - **US12c:** the approval-round detail, plus the portal detail and sign-off.
  - **US12d:** compose (staff proxy and portal), plus the benefits page's E-Blast tab.
- **Queue selection uses AURA's own per-row predicate** (maintainer, 18 Oct). DataTable's `isRowSelectable` / `rowSelectDisabledLabel` shipped in 5.6 (handoff 52), so only rows awaiting marketing review get a checkbox (acceptance 1). The fallback in acceptance 1, a local selection column, is dropped.
- **The Tiptap loader moves to the shell.** `ui/tiptap-loader` is a `next/dynamic` wrapper, not a kit component. It moves to `src/components/shell/tiptap-loader.tsx` and draws its loading state with the shared skeleton blocks. Its importers and test mocks follow, as `RelativeTime` did in US3. The status role, label and test id are unchanged.
- **Template filter pills are AURA `Tag`s.** A selectable `Tag` is a `<button aria-pressed>` with a check when selected, as the board draws the pills. The fieldset legend and the separate polite count stay.
- **The marketing audience takes the global filter pattern** (the § Filters rule): search in the bar, contact role / marketing state / member eligibility as `FilterSelect`s, chips and Clear all, collapsing into the Filters sheet on phones. The board's four labelled fields are not drawn, for the same reason as the audit log (US10b). The count line stays the page's own `#audience-count`, not the bar's `resultCount`, because it is the focus target when the last row leaves a filtered view.
- **`ui/filter-bar` loses its last importer** with the audience page. It is deleted with the rest of `src/components/ui` at US13.
- **The marketing area's error boundary** (`marketing/error.tsx`, which also covers the audience page) moves to the shared `RouteErrorPanel`.
- **Unchanged (FR-011):** every guard and its order (the brand page checks permission before the flag; the allowlist page checks the flag first); every request body and response branch; toasts and error-code maps; the audience URL contract, debounce and preflight preset; no audience CSV; the starter-edit banner; the unsaved-changes guard; the allowlist remove dialog's final focus.
- `tests/unit/components/marketing/audience-table.test.tsx` reads `src/components/ui/sidebar.tsx` for its width budget. US13 must re-home that read when it deletes the folder.
- **Board content not drawn in US12a** (FR-011; each would be new copy or behaviour):
  - the phone templates board's "Custom" badge on admin-authored rows and its "Show 11 more" button (every row stays listed);
  - the brand board's "How it looks in an E-Blast" preview (the form has no preview today);
  - the audience board's four labelled filter fields (the global filter pattern instead, above).
- **The audience page's presentation moves to `_components/audience-view.tsx`** (`AudienceFrame`, `AudienceResults`) so the preview harness can render it; the page keeps the guards, parsing and reads, and its own `TableContainer` (check:layout).
- **UX review (enterprise-ux-designer: ship with follow-ups, no HIGH), applied in US12a:**
  - **Audience rows become cards on phones** (maintainer, 18 Oct). Below 640 px each contact is an AURA stacked card (contact as the title, the switch as the action, every other column a labelled field), as the board draws it. From 640 px it is the table as before; its fixed layout and min-width apply from `sm` up only. This amends spec 108 FR-035c, and e2e test 6 now asserts that nothing scrolls sideways at 320 px.
  - Templates: the subject wraps on phone cards instead of being cut; the visible count sits beside the pills (aria-hidden, the polite status stays the one announcement); the Starter badge's fuller name is sr-only text, not an `aria-label` on a span; the loading skeleton draws cards below 640 px.
  - Brand: the colour field and its swatch stay side by side at every width; the swatch uses `--aura-border-control`; Save is full width on phones.
  - The label offset that sets a control level with an AURA field's box is one shared constant (`src/components/shell/field-box-offset.ts`).
  - The invalid colour gets AURA's danger border from `aria-invalid`, not from AURA's `error` prop, which would replace the field's hint id with its own (maintainer, 18 Oct). It was a stand-in until AURA #156 (Addendum 57: an invalid state without a message); AURA 5.50 shipped `invalid` and US12b adopts it.
- **Every staff form page starts at the content's left edge** (maintainer, 18 Oct): `<FormContainer align="start">`, as the plan, invoice-void, credit-note, account and import forms already did. This PR adds it to the template new/edit, broadcast settings and brand pages, and to the two older admin forms still centred (new invoice, reminder schedules). `tests/unit/architecture/admin-form-align.test.ts` keeps every future staff form on it. Member portal forms stay centred.
- **Parity comments (maintainer, 18 Oct):**
  - Templates on phones: the outer card frame and its padding drop away (AURA `flushBelow`), and each card ends in a full-width outline Edit button, as board `Admin-broadcast-templates-mobile` draws it; desktop keeps the ghost Edit link.
  - Template new/edit: Cancel (outline) and Save sit in the pinned phone action bar the member and plan forms use (`.template-form-actions`); the board's "Unsaved changes" status line is not drawn, as on those forms.
  - Marketing audience on phones: a list of contact cards replaces the table (board `Admin-marketing-audience-mobile`): name with the role pill, email, member link, state with reasons and "Broadcasts halted"/"Erased", the last change, then a "Receives E-Blasts" row with the switch (new copy in EN/TH/SV). The active member status is not repeated. The outer frame drops away below 640 px. This replaces the AURA stacked-table cards from earlier the same day.
  - Templates on phones: the Starter badge sits at the right end of each card's title row, as the board draws it (maintainer, parity comments 18 Oct); in the table it still follows the name. The board's "Custom" badge for admin-authored templates is not added.
  - Template form action bar: no "Unsaved changes" line (maintainer, parity comments 18 Oct: "decide, keep it consistent"). No other form with the pinned action bar shows one. The template form has no leave-page prompt, before or after this PR; adding one would be new behaviour.
  - Brand page: the board's "How it looks in an E-Blast" card is added in this PR at the maintainer's request (18 Oct). It sits in the colour card and follows the typed colour and address before Save. The header and footer are the real e-mail's: the logo, or the chamber name (`resolveTenantDisplayName`, the name the e-mail carries) when there is none; then the footer lines from the same `email.broadcastFooter` strings, with the address, or "Sent by …" when there is none. The privacy-inbox line is left out, as on the board. It uses the e-mail's fixed light colours in both themes, except the footer grey: #6b6b6b (5.3:1) instead of the e-mail's #888 (3.5:1), because text on this page must meet AA. New EN/TH/SV strings `admin.settings.broadcasts.brand.colour.preview.*`. Presentation only: no new request.
  - The new-template card no longer repeats the page title and subtitle, and the edit-template card no longer repeats the subtitle under the template name (maintainer, 18 Oct). The board draws the repeat; the page header already says it.

### Session 2026-10-18 (US12b start: the review queue)

- **AURA 5.50 (#156, Addendum 57)** ships `invalid` on `TextField`, `Textarea` and `Field`: the danger look and `aria-invalid`, with no message and `aria-describedby` left alone. The brand colour field adopts it and its field-DOM selector stand-in goes. The pin is 5.50.0.
- **Selection** moves from TanStack to AURA `DataTable` `selectable` + `isRowSelectable` (rows awaiting marketing review only, i.e. `status === 'submitted'`) + `rowSelectDisabledLabel`. The selection stays controlled by the queue, so clear-after-success, keep-only-the-failed-rows after a partial bulk failure, and the prune-on-refresh behave as before. Acceptance scenario 1's "local selection column" fallback is no longer needed.
- **Phone cards follow board `Admin-broadcasts-mobile`** (maintainer, 18 Oct, "as recommended"). Each card shows the date with the waiting / overdue chip, the subject, the member, and audience · recipients, then ends in one full-width "Review" button that opens the E-Blast's detail page. Phone cards have no checkbox and no inline Approve / Reject: approve and reject stay on the detail page one tap away. The cards show below 768 px and the table with bulk selection from 768 px up, the breakpoint the queue already used. One departure from the board: the card keeps the stage pill, whose turn and time in stage, because FR-026 names them among the phone-width fields. A stage nobody is waiting on shows neither line, rather than "—".
- **Columns:** the FR-026 fields stay on the row (member, subject, stage with round and delivery results, whose turn, time in stage, send time, audience and recipients, actions). The board's older column set does not drop any of them.
- **Shared dialogs:** the reason-confirmation dialog and the typed-phrase field move to AURA in this PR. Their US12c callers (cancel, member sign-off) pick up the new look without changing. `useDialogFinalFocus` keeps its export, so the members and renewals importers are untouched.
- **Unchanged (FR-011):**
  - the guards (`broadcasts.read`; manager = no `broadcasts.write`);
  - the URL contract (repeatable `status`, `status_all=1`, `memberId`, `fromDate`/`toDate`, `cursor` reset, Upcoming = `sort=scheduled_for&from=now`, 300 ms debounce, `router.replace`);
  - the request bodies (approve `{decision}` or `{decision:'schedule', scheduledFor}` in Bangkok wall time; bulk per row, five at a time with `allSettled`, capped at `BULK_CAP`; reject `{rejectionReason}` ≤ 2000; clear halt `{}`; the send-now undo's cancel);
  - every toast;
  - the selection announcer and order hint;
  - the halt, SLA and overdue banners;
  - the typed-phrase normaliser (case-insensitive, unlike the refund gate).
- **Parity comments (maintainer, 19 Oct: "group it neatly", "why two boxes?"):**
  - The Stage chips sit in labelled rows, "In review" and "Closed", each named by its caption on screen (the caption on the left from 640 px, above the chips on a phone). The two presets move into a third row, "Quick views", before the member and date fields.
  - From / To become one AURA "Submitted" `FilterDateRange` in the tenant timezone, as audit (US10b) and change requests already do. The `fromDate` / `toDate` URL keys and their server parsing are unchanged. The picker writes a whole range (or "Any time") at once, so the 300 ms date debounce goes, and the UI no longer sets a lone "from" day; a URL that carries one still filters, the same step audit took.
  - The typed-phrase field shows its phrase once. When the label already names it ("Type Acme Co., Ltd. to confirm", "Type CANCEL to confirm"), the grey copy under the label goes: it read as a second field and, being focusable, took the dialog's first focus. A subject gate, whose label only refers to the phrase, keeps the box and its copy button.
  - The table folds "Whose turn" into the Stage cell, as a line under the pill ("Whose turn: Marketing"); every FR-026 field stays on the row, and the contract pins the row's fields, not its column headers. Stage takes the 80 px the column had (120 → 200 px), so an EN stage pill sits on one line; the column minimums still add up to 868 px, inside the 871 px a 1,280 px screen leaves. A pill that still wraps (the longest SV stages) gets a 16 px radius instead of a full pill's, so two lines read as a rounded box rather than a lozenge; on one line the radius clamps to a full pill (stand-in until AURA #158).
  - The loading skeleton rows are as tall as real rows (88 px, Approve over Reject) and carry the select column, so the page no longer moves when the data lands (UX review L10).
  - The bulk confirm lists the E-Blasts it will approve (subject, member · recipients), as the board draws it, from the queue's own rows; a long selection scrolls inside the list (maintainer, 19 Oct; it was Decided out as new content in a UI swap).

## User Scenarios & Testing *(mandatory)*

Every story below is one phase and one pull request. A story is done when its screens use only AURA components, match their canvas boards, and pass the per-module definition of done (FR-010).

### User Story 0 - Foundation: every screen already speaks AURA's visual language (Priority: P1)

Staff and members open any existing page and see AURA's colours, type, radius and toasts — before a single screen is rebuilt — because the old kit's colour and radius variables are fed from AURA's tokens, AURA's fonts replace the old font, and every toast in the product comes from one AURA toast surface at the top centre of the screen. Developers get the rails for the next phases: the AURA packages, the provider that tells AURA the user's language and calendar, a lint rule that stops migrated code from importing the old kit, test helpers, and the updated UX playbook.

**Why this priority**: every later phase depends on it, and it gives the whole product the new look at once at low risk.

**Independent Test**: open `/admin`, `/portal`, a form and a table in EN, TH and SV, light and dark; trigger a success, an error and a read-only toast; confirm AURA colours/fonts, one toast at top centre, Buddhist-era dates on TH only, and no layout or behaviour change.

**Acceptance Scenarios**:

1. **Given** any existing page, **When** it renders, **Then** its text uses the AURA font families and its surfaces, borders, focus rings, charts and sidebar use AURA's colour tokens, in both light and dark themes.
2. **Given** an action that shows a toast (success, error, warning, read-only), **When** it fires, **Then** one AURA toast appears at the top centre with the same title and description as before, is announced to screen readers, and at most three are visible at once.
3. **Given** a Thai-language session, **When** an AURA component shows a date, **Then** the year is in the Buddhist Era; in EN and SV it is Gregorian; stored values are unchanged.
4. **Given** new or migrated code, **When** it imports the old toast library, AURA's generic date formatter, or (in a migrated path) the old component kit, **Then** the lint gate fails.
5. **Given** the production security policy, **When** pages load, **Then** no font or stylesheet is fetched from a new external origin.

---

### User Story 1 - Shell: one AURA frame around every page (Priority: P1)

Staff get AURA's sidebar navigation, header, user menu, breadcrumb, pagination and command palette; members get AURA's top navigation and phone bottom bar; everyone gets AURA's idle-warning and confirmation dialogs, empty states and skeletons. The page containers keep their current contract, so every page still lays out as before.

**Why this priority**: the frame is on every screen; after it, each module is a local change.

**Independent Test**: navigate every top-level section at 390 and 1280 px as admin, manager and member; open the command palette; trigger the idle warning; compare with the Templates and shell boards.

**Acceptance Scenarios**:

1. **Given** each role, **When** it opens the portal, **Then** it sees exactly the navigation entries its permissions allow (unchanged), in AURA's side or bottom navigation.
2. **Given** the command palette shortcut, **When** pressed, **Then** the AURA palette opens with the same actions and keyboard behaviour as before; the palettes no longer use the old palette library.
3. **Given** the existing page-layout checks and end-to-end selectors, **When** the shell is swapped, **Then** the layout-container contract passes unchanged; selectors that named the old kit's internals (`data-slot="sidebar*"`, cmdk testids, `data-active`) move to roles and names, and the top-bar heights follow the boards (supersedes spec 004 SC-009, see Clarifications).

---

### User Story 2 - Auth pages (Priority: P2)

Sign-in (staff and member), forgot/reset password, invitation acceptance and the related states use AURA text, password and checkbox fields and AURA's form error summary.

**Independent Test**: complete sign-in, a failed sign-in, a password reset and an invitation acceptance in EN/TH/SV at 390 and 1280 px.

**Acceptance Scenarios**:

1. **Given** invalid input, **When** submitted, **Then** the AURA error summary lists each error, links to its field and receives focus; messages are unchanged.
2. **Given** a screen reader, **When** the password visibility toggle is used, **Then** its state is announced.

---

### User Story 3 - Member home, profile and account (Priority: P2)

Members see their dashboard, benefits, company profile, change requests and account settings in AURA cards, stats, status pills and link tabs, with each form's buttons at the end of its card as the boards draw them.

**Independent Test**: as a member, review the dashboard, edit the profile, submit and withdraw a change request, and change the notification language — compare with the member-portal boards.

**Acceptance Scenarios**:

1. **Given** a portal form, **When** it renders on a phone, **Then** its buttons sit at the end of the form card, full width and stacked with the primary action on top; from 640 px they sit in one row at the end (Session 2026-09-27).
2. **Given** unsaved input in the profile edit / change-request form, **When** the member tries to leave the page, **Then** the browser asks before discarding it.

---

### User Story 4 - Member invoices and payment (Priority: P2)

Invoice list, invoice detail, receipts, credit notes and the card/PromptPay pay sheet use AURA tables, status pills and alerts, and the pay sheet is an AURA drawer on the right (full screen on phones) around the unchanged Stripe Elements (Clarifications, US4 start). Amounts, document numbers, VAT lines and document wording are unchanged.

**Independent Test**: open an unpaid bill, pay it in the test environment, download the receipt, open a credit note — every figure matches the pre-migration screen.

**Acceptance Scenarios**:

1. **Given** any money screen, **When** migrated, **Then** every amount, VAT line, document number and status is identical to before (a financial-integrity review signs this).

---

### User Story 5 - Members administration (Priority: P2)

Members list (server-paged, sorted, filtered), member detail, create/edit, directory, change-request review and bulk actions use AURA's data table in server mode, filter bar and bulk action bar. Two pull requests (Session 2026-09-28, US5 start): US5a covers the list, directory and change requests; US5b covers member detail, timeline, benefits, the forms and the member dialogs. US5b is itself two pull requests (Session 2026-09-29): US5b-1 the detail page with its sub-pages and dialogs, US5b-2 the forms and their dialogs.

**Independent Test**: page, sort, filter and bulk-act on the members list with the same results and URLs as before.

**Acceptance Scenarios**:

1. **Given** a filtered, sorted page of members, **When** the URL is shared, **Then** it reopens the same view (unchanged URL contract).

---

### User Story 6 - Plans (Priority: P3)

Plans list, detail, create wizard, edit and clone use AURA forms, selects and switches (the boards draw no segmented control; Clarifications, Session 2026-09-30 US6 start).

**Independent Test**: create, edit and clone a plan; the stored plan is identical to one made before the migration.

**Acceptance Scenarios**:

1. **Given** the plan wizard, **When** a step has errors, **Then** the AURA error summary lists them, the stepper marks the step, each field shows its own, and the wizard stays on (or, on Save, returns to) that step.

---

### User Story 7 - Renewals (Priority: P2)

The renewals pipeline (table and phone card list become one AURA data table), cycle detail, tasks, tier upgrades and schedules.

**Independent Test**: filter the pipeline, open a cycle, record a payment, snooze an at-risk member.

**Acceptance Scenarios**:

1. **Given** a phone, **When** the pipeline renders, **Then** each row stacks as a card from the same table (no second list).

---

### User Story 8 - Invoicing administration (Priority: P2)

Invoice list/detail, tax registers (summary line above the table), credit-note, refund, record-payment and void dialogs.

**Independent Test**: issue, pay, credit and void test invoices; register totals and CSV export equal the pre-migration output.

**Acceptance Scenarios**:

1. **Given** a register month, **When** migrated, **Then** row count, totals and the export match exactly (financial-integrity review).

---

### User Story 9 - Events (Priority: P3)

Events list/detail, attendee import (file upload + column mapping), EventCreate integration, erasure pages; date and time pickers in Bangkok time.

**Independent Test**: import an attendee CSV, map columns, open erasure as super admin.

**Acceptance Scenarios**:

1. **Given** a typed date outside the allowed range, **When** entered, **Then** the AURA date field refuses it with a message (no silent clamp).

---

### User Story 10 - Users, audit log, compliance and settings (Priority: P3)

Users list and role changes, audit log, erasure log, and every settings page.

**Independent Test**: invite a user, change a role, filter the audit log, save each settings page.

**Acceptance Scenarios**:

1. **Given** a destructive menu item (e.g. deactivate user), **When** shown, **Then** it uses AURA's danger item and a confirmation dialog.

---

### User Story 11 - Staff dashboard (Priority: P3)

KPI tiles become AURA stats; charts keep their data and chart type, recoloured with AURA's chart palette.

**Independent Test**: every KPI value and chart series equals the pre-migration dashboard for the same data.

**Acceptance Scenarios**:

1. **Given** dark mode, **When** charts render, **Then** every series meets contrast rules against its background.

---

### User Story 12 - E-Blast (Priority: P3)

The review queue (server-paged, stage chips, per-row selection), approval-round detail, formatted-version workspace, schedule dialog, templates, marketing audience, broadcast settings and brand, and the member compose/list/detail/sign-off screens — per the canvas page "E-Blast — two-sided approval (F119)".

**Independent Test**: run one E-Blast through submit → formatted version → member approval → schedule with the feature flag on.

**Acceptance Scenarios**:

1. **Given** the review queue, **When** rows in different stages are shown, **Then** only rows awaiting marketing review can be selected for bulk approval (AURA `DataTable` `isRowSelectable`, handoff item 52).

---

### User Story 13 - Exit: one component library (Priority: P1)

The old component kit folder, its primitives library, the old toast/palette/date-picker libraries and the table-UI library are removed; the lint rule forbids the old kit everywhere.

**Why this priority**: it closes the Constitution Principle VI exception by its deadline.

**Independent Test**: a search for imports of the old kit returns nothing; the build, all gates and the full end-to-end suite pass.

**Acceptance Scenarios**:

1. **Given** the codebase at Exit, **When** searched, **Then** there are zero imports of the old component kit and the removed libraries are absent from the dependency list.
2. **Given** the date the foundation merged, **When** Exit merges, **Then** no more than 10 weeks have passed (or the exception was renewed through a documented decision).

### Edge Cases

- A page migrated in phase N embeds a component still on the old kit (e.g. a shared dialog): overlays from the two libraries must not stack inside one another; the shared piece migrates with the first module that needs it, or both render with the agreed layer order so focus and scroll lock stay correct.
- An AURA component lacks a behaviour Chamber-OS needs (e.g. item 52): the gap is added to the AURA handoff doc, and the module keeps a small local wrapper, marked for removal, until AURA ships it; the module is not blocked.
- A toast call passes an option AURA does not support (e.g. a promise toast): the toast facade emulates it with loading → success/error; no call site breaks.
- A Thai page shows a year from a component that formats dates itself: it must show the Buddhist Era; a Swedish or English page must not.
- Reduced motion is on: skeletons do not pulse and toasts do not slide.
- A phone at 320 px: no horizontal scroll on any migrated page; tap targets stay at least 44 px.
- Read-only mode (write freeze) or a manager's read-only role: the existing banners and hidden actions behave exactly as before.
- The AURA package publishes a breaking release mid-migration: the exact version pin holds until a dedicated upgrade PR.

## Requirements *(mandatory)*

### Functional Requirements

**Foundation (US0)**

- **FR-001**: The product MUST use the AURA packages at one exact, pinned version, upgraded only in a dedicated change.
- **FR-002**: Every existing page MUST take AURA's colour, radius and font tokens for its surfaces, text, borders, focus rings, charts and navigation, in light and dark, without its layout changing.
- **FR-003**: AURA's fonts MUST be served from the product's own origin; no new external origin may be added to the content-security policy.
- **FR-004**: The period in which both component libraries coexist MUST NOT exceed **10 weeks** from the foundation merge, recorded as a documented exception to Constitution Principle VI; renewing it requires a new documented decision.
- **FR-005**: AURA components MUST receive the user's language (EN/TH/SV), use the Buddhist calendar for Thai and the Gregorian calendar otherwise, render internal links through the app's router, and use a compact density on staff pages and a comfortable density on member pages.
- **FR-006**: All dates the product formats itself MUST keep going through the existing localised formatter; AURA's generic date formatter MUST NOT be used directly.
- **FR-007**: All toasts MUST come from one AURA toast surface at the top centre; every existing toast keeps its title, description, tone and action; at most three are visible; the old toast library is removed in the foundation.
- **FR-008**: A lint gate MUST reject imports of the old toast library and of AURA's generic date formatter everywhere, of the old command-palette library once its last consumer migrates (US1 moves both command palettes; the pickers that also use it move with their modules, at the latest US13), and of the old component kit inside every path already migrated (a list that grows with each phase); a test MUST prove the gate catches each banned import.
- **FR-009**: Loading skeletons MUST use AURA's pulse style from US1 onward; the UX playbook MUST describe AURA as the component library and the pulse as the skeleton standard.

**Every module phase (US1–US12)**

- **FR-010**: A phase is done only when (a) its paths import nothing from the old component kit, (b) its screens match their canvas boards at 390 and 1280 px in light and dark, (c) the layout, i18n, strict-ARIA and date gates pass, (d) its unit/component tests and all required CI checks pass (the end-to-end, accessibility and locale suites run locally only at the checkpoints — the shell specs after US1, the full suite after the money phases US4/US8 and before US13 — not per phase), (e) bundle budgets are re-baselined, and (f) a UX review — and on money screens a financial-integrity review — has signed it.
- **FR-011**: A phase MUST NOT change module logic, stored data, API contracts, permissions, audit events or money figures; logic defects found along the way are fixed in separate pull requests, merged before the phase's UI change.
- **FR-012**: Page containers MUST keep their current contract (props and the attributes the layout gate and end-to-end tests select on) until US13.
- **FR-013**: Every migrated screen MUST meet WCAG 2.1 AA, work at 320 px without horizontal scroll, keep 44 px tap targets, honour reduced motion, and keep EN/TH/SV text parity.
- **FR-014**: Overlays from the two libraries MUST NOT nest; their stacking order MUST follow AURA's layer scale (dialog below menu below toast below tooltip).
- **FR-015**: Tables that page, sort or filter on the server MUST keep their URL contract (shared links reopen the same view).
- **FR-016**: Where AURA lacks a needed behaviour, the gap MUST be logged in the AURA handoff doc and bridged by a local wrapper marked for removal; the wrapper MUST be removed when AURA ships the behaviour, at the latest at US13.

**Exit (US13)**

- **FR-017**: At Exit the old component kit, its primitives library and the old toast, command-palette, date-picker and table-UI libraries MUST be removed, and the lint gate MUST forbid the old kit everywhere.

### Key Entities

- **Design token**: a named colour, radius, font, spacing, density or layer value owned by AURA; Chamber-OS's legacy variables become aliases of these during the migration.
- **Migrated path**: a directory whose screens are on AURA; listed in the lint gate so regressions fail.
- **Canvas board**: the reference design for one screen state and width on the design canvas; the acceptance reference for visual parity.
- **AURA handoff item**: a numbered requirement Chamber-OS raised with AURA (1–52), with a gap, a proposal, acceptance criteria and a Chamber-OS stop-gap.

### Chamber-OS cross-cutting requirements *(mandatory — answer each; "N/A because …" is an answer, a blank is not)*

- **Roles & permissions**: no change. Every role sees exactly the actions and navigation it sees today; the shell phase re-implements the navigation from the same permission evaluator (never from role bundles). No new permission keys.
- **Tenant scope**: N/A because no data, query or repository changes; presentation only. Tenant branding stays in the E-Blast brand settings; the product UI brand colour (#10487A) is a single committed theme.
- **Locales**: all user-facing text stays in EN (canonical) + TH + SV with parity; AURA's built-in labels come in EN/TH/SV and follow the active locale, so TH/SV never fall back to English; Buddhist Era is display-only for Thai (FR-005/FR-006).
- **Personal data**: N/A because no field is collected, stored, displayed differently or sent anywhere new; fonts and styles stay on the product's origin (FR-003), so no new third party receives visitor data.
- **Audit trail**: N/A because no state change is added or altered; UI swaps must not add, drop or rename audit events (FR-011).
- **Money & tax**: not touched in logic; money screens (US4, US8) must show identical figures, statuses and document wording, verified by a financial-integrity review (FR-010f).
- **Feature flag / kill-switch**: none — a presentation swap per module; rollback is reverting that phase's PR. Live on merge of the foundation: AURA tokens/fonts on every page, the AURA toast, the lint gate. The existing E-Blast and member-change flags are unaffected.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After the foundation merges, 100% of pages show AURA's fonts and colour tokens, and every toast in the product appears at the top centre.
- **SC-002**: After each phase, the number of old-kit imports in that phase's paths is zero, and the total across the codebase falls monotonically to zero at Exit.
- **SC-003**: Exit merges within 10 weeks of the foundation merge.
- **SC-004**: No phase changes a stored value, money figure, audit event or API response (verified by the unchanged integration and contract suites).
- **SC-005**: Accessibility scans report zero WCAG 2.1 AA violations on every migrated screen, at 320/390 and 1280 px, light and dark.
- **SC-006**: Every migrated screen matches its canvas board closely enough that a reviewer comparing them side by side finds no unexplained difference (differences are either listed as proposals on the board or fixed).
- **SC-007**: Initial page load does not regress by more than the re-baselined bundle budget per route, and layout shift from the font change stays below 0.1 on `/`, `/portal` and `/admin`.

## Assumptions

- The AURA maintainer is also the Chamber-OS maintainer and fixes AURA gaps in parallel; the handoff doc is the contract between the two.
- AURA 5.5.0 covers handoff items 1–51 (5.6.0 adds 52–56; 5.7.0 adds 57–62; 5.7.1 adds 63; 5.7.2 adds 64; 5.7.3 adds 65; 5.8.0, the pin since US3, adds 66–69) and exposes the same package entry points as 4.17 (verified on the registry 2026-09-26); no item is open.
- The ~300 canvas boards are the visual reference; where a board is marked "Proposed", the phase may either implement the proposal or keep the current behaviour, and says which in its PR.
- End-to-end tests have no CI job and run locally; each phase links its run log.
- The dashboard's charting library stays; only its colours move to AURA's chart palette.
- The product UI has one brand theme (SweCham #10487A) for now. Per-tenant UI colours belong to the future white-label feature (F12, `docs/saas-architecture.md` § 8); the brand theme is kept in one place so F12 can later supply it per tenant at runtime without touching screens.
- Visual parity (SC-006) is judged by a reviewer comparing screenshots of the running page against its canvas board at 390 and 1280 px, light and dark, attached to the phase's PR; there is no pixel-diff gate, because the boards use sample data.
- Queued logic-bug tasks (void/auto-refund rules; TH/SV wording and bill labels; colleague contact data; E-Blast PDPA) land as their own PRs and are not part of this feature.
- Out of scope: backend, database, API behaviour, permissions, and copy changes beyond what a component swap forces or a canvas board words differently (Session 2026-09-27).
