# Contract — Contact marketing state, Marketing audience page, invariant surfaces

## 1. Staff toggle

`POST /api/admin/contacts/[contactId]/marketing` — gate `requireApiPermission(request,
'contacts.marketing')` inside the handler; baseline row `POST /api/admin/contacts/[contactId]/marketing`.

Request `{ "state": "on" | "off" }` (zod, strict). Idempotency: same state → `200 { outcome:
'unchanged' }`, no audit. Rate limit `contacts:marketing:{tenant}:{user}` 60/min, consumed
atomically before the write (FR-030b); the portal self-toggle uses the same limit. `Idempotency-Key`
header required (400 `missing_idempotency_key`, same helper as `POST …/contacts`); a replayed key
returns the stored outcome and emits no second audit row. The portal self-toggle applies the same
header rule.

| Status | Body | When |
|---|---|---|
| 200 | `{ outcome: 'changed', contact: <serialiseContact> }` | state flipped; audit `contact_marketing_opted_out` / `_in` `{ member_id, contact_id, source: 'staff' }`, actor role = session role |
| 200 | `{ outcome: 'unchanged' }` | already in that state |
| 404 | problem `not_found` | contact removed / other tenant (non-disclosure) |
| 409 | problem `suppressed` | `state: 'on'` while the address is on the suppression list (FR-025) |
| 403 / 401 | RBAC denial (audited) | |

Use case `setContactMarketingOptOut(deps, { contactId, state, actor: { userId, role, source:
'staff' } })` in `members/application`; deps `{ tenant, contactRepo, audit,
marketingSuppression: MarketingSuppressionLookupPort }` — the last adapter lives in
`src/lib/contact-marketing-deps.ts` (no members→broadcasts module import).

## 2. Portal self-toggle

`PATCH /api/portal/profile/marketing` — `requireMemberContext`; acts on `ctx.ownContactId`
only. Request `{ "optOut": boolean }`. Same use case with `source: 'self'`. 409 `suppressed`
when the contact's address is on the suppression list (the portal hides the control in that
state and shows "unsubscribed"). `GET /api/portal/profile` gains
`marketing: { state: 'on' | 'off_by_staff' | 'off_by_contact' | 'unsubscribed' }` per contact
(own contact only carries the control).

## 3. Marketing audience page

`/admin/marketing/audience` — `requirePagePermission('contacts.read')`; `TableContainer` in
`page.tsx` **and** `loading.tsx`; nav item under Engagement with `guard:
defineGuard('contacts.read')`; breadcrumbs `breadcrumb.marketing`, `breadcrumb.audience`.

Columns: member (link), contact name, primary/secondary, member status, marketing state
(badge, text + icon, never colour-alone), changed by / at, switch (rendered only when
`canPerform(role, 'contacts.marketing')`; read-only badge otherwise). Filters (URL search
params as the single source of truth — a search box plus three `Select` filters and a
"Clear filters" button, the members-directory pattern; there are no removable chips): `q`
(member/contact name), `member_id`, `kind=primary|secondary`,
`state=on|off_staff|off_contact|unsubscribed`, `eligible=1` (member active + not erased +
not halted). Page size 50, offset pagination via `TablePagination`; count shown above the
table. Pre-flight preset link: `?kind=secondary&state=on&eligible=1`.

Data: `listMarketingAudience(deps, { filter, limit, offset })` in `members/application`
returns contacts with opt-out fields + member status; the page resolves suppression with
the existing `resolveContactSubscriptions` tri-state (degraded ⇒ "status unavailable").
Marketing role sees name + email + state only — no DoB, phone or other `pii_sensitive`
fields (T057 fence).

Responsive: same as the members directory — `overflow-x-auto` inside `TableContainer`, page never
scrolls horizontally; name + state columns ordered first so they stay in view at 320 px (FR-035c).

Toggle interaction: `Switch` + optimistic local state (flips on click, rolls back on any
refusal) + `fetch` + `startTransition(router.refresh)` with the switch disabled until the
refresh settles; `toast.success` on change, `toast.info` on `unchanged`, `toast.error` with
the localized reason on 409/403/5xx. Under a state-filtered view the row leaves on refresh:
focus is handed to the next row's switch (else the count line) BEFORE the refresh and the
toast says the row left the view. Every request — including the Undo action — sends its own freshly
generated `Idempotency-Key`; a reused key returns the stored outcome and would make Undo a no-op
(FR-030b / FR-030c).

## 4. Member detail page

Each `ContactBlock` keeps the existing "Primary" badge (with the descriptor "receives
invoices and payment emails"; the phrase "billing contact" is never rendered — FR-031) and
gains a marketing badge with the four states plus "status unavailable" (FR-031a); the switch
appears for holders of `contacts.marketing`, with a 10-second Undo toast on switch-off and no
confirmation dialog (FR-030c). A non-dismissible warning banner "No primary contact — payment
emails are not being sent" renders at the top of the member page and of each of its invoice
pages when the member is non-archived, non-erased and has no live primary (FR-003).

## 5. Contact removal, promotion, unarchive

| Route | Change |
|---|---|
| `DELETE /api/members/[memberId]/contacts/[contactId]` | 409 `cannot_remove_primary` now also raised by the repo guard (`is_primary = false` predicate) and by the post-mutation invariant check; message unchanged |
| `POST …/promote-primary` | unchanged contract; race now surfaces as 409 `primary_contact_race` from the deferred trigger |
| `POST /api/members/[memberId]/undelete` | body may carry `{ designate_primary_contact_id?: uuid }`; 409 `no_primary_contact` `{ designatable: [{ contact_id, first_name, last_name, email }] }` when none is live and none designated; success unchanged |

UI: `archived-banner.tsx` on 409 `no_primary_contact` opens `RestorePrimaryDialog` (radio
list of designatable contacts, "Add contact" link when empty, `finalFocus` back to the
banner CTA).

## 6. i18n keys (EN canonical, TH + SV required)

`admin.marketing.audience.*` (title, subtitle, columns, filters, states, toasts, empty
states), `admin.members.detail.marketing.*` (badge labels, banner), `portal.profile.marketing.*`,
`nav.staff.marketingAudience`, `breadcrumb.marketing`, `breadcrumb.audience`,
`audit.eventType.contact_marketing_opted_out|contact_marketing_opted_in|auto_email_skipped_no_recipient`,
`portal.broadcasts.compose.estimateNote.*` (rewritten, interpolates `{ceiling}`) +
`selfExclusionHint`, `errors.suppressed`, `errors.no_primary_contact`.

## 7. Tests

- Contract: toggle route (super_admin happy path, marketing allowed, manager 403, unknown
  contact 404, suppressed 409, cross-tenant 404 + probe audit), portal self-toggle (own
  contact only), undelete designate.
- Unit: `setContactMarketingOptOut` (all branches, 100% — pin in `vitest.config.ts`),
  `listMarketingAudience` filter mapping, nav parity, catalogue/evaluator pins.
- Integration (live Neon): promote-vs-remove race ×100 (SC-002) extending
  `primary-contact-race.test.ts`; trigger rehearsal (bad unarchive rejected at commit;
  erasure passes); cross-tenant isolation for the new query and route (Principle I).
- E2E (`--workers=1`): audience page for marketing + manager personas (axe `@a11y`, `@i18n`
  three locales), member-detail toggle, portal self-toggle, `rbac-navigation` lists updated.
