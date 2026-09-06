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
| 200 | `{ outcome: 'changed', contact: <serialiseContact> }` | state flipped; audit `contact_marketing_opted_out` / `_in` with payload `{ related_member_id, contact_id, source: 'staff', actor_role }` — `related_member_id` (NOT `member_id`) for a staff action so migration 0009's `last_activity_at` bump does not fire; the portal self-toggle audits `{ member_id, contact_id, source: 'self', actor_role }`. `actor_role` = session role, never a literal |
| 200 | `{ outcome: 'unchanged' }` | already in that state (a staff "off" over the person's own "off" is also `unchanged` — the person's record is kept) |
| 404 | problem `not_found` | contact does not exist / other tenant (non-disclosure; probe audited) — or removed in this tenant (same 404, NOT probe-audited) |
| 409 | problem `suppressed` | `state: 'on'` while the address is on the suppression list (FR-025) |
| 409 | problem `self_opted_out` | `state: 'on'` over the person's OWN opt-out (FR-025 AMENDMENT) — decided by a pre-read AND re-checked under the row lock, so a self opt-out that lands between the two still wins |
| 503 | problem `suppression_unavailable` (+ `Retry-After`) | `state: 'on'` while the suppression list cannot be read — a blind "on" could override an unsubscribe nobody checked (FR-031a) |
| 429 | problem + `Retry-After` | 60/min per (tenant, user) exhausted |
| 403 / 401 | RBAC denial (audited) | |
| 400 | problem `invalid_body` | body is not exactly `{ state: 'on' \| 'off' }`, or is not JSON |
| 409 | problem `idempotency_conflict` | the same `Idempotency-Key` with a different body |
| 503 | problem `idempotency_reservation_failed` (+ `Retry-After`) | the reservation store is unavailable |
| 500 | problem `server_error` | anything else; the message is a synthetic `set-marketing: <code>`, never a DB message |

**Idempotency-Key after a FAILED request** (house convention, confirmed at the
PR-D review): only a 200 is remembered. A key whose request ended in 4xx/5xx
leaves a reservation with no stored response, and `classifyIdempotencyRequest`
reads that as a CONFLICT for the 24 h TTL — so a retry after a 503 MUST use a
NEW key, not the same one. Both UI clients mint a fresh UUID per request 
(the Undo included), which is why this never surfaces in the app; an
integration written against this contract would hit it. Same rule on §2.

Use case `setContactMarketingOptOut(deps, { contactId, state, actor: { userId, role, source:
'staff' } })` in `members/application`; deps `{ tenant, contactRepo, audit,
marketingSuppression: MarketingSuppressionLookupPort }` — the last adapter lives in
`src/lib/contact-marketing-deps.ts` (no members→broadcasts module import).

## 2. Portal self-toggle

`PATCH /api/portal/profile/marketing` — `requireMemberContext`; acts on `ctx.ownContactId`
only, and the request body carries NO contact id (`{ "optOut": boolean }`, `.strict()`), so a
member cannot address anyone else's contact. Same use case with `source: 'self'`.
`Idempotency-Key` required. Rate limit 60/min per (tenant, user) — the SAME bucket as the
staff toggle, so switching surfaces does not buy extra budget.

Responses (staff review A5 — §2 previously listed only the 409):

| Status | Body `error.code` | When |
|---|---|---|
| 200 | — | changed, or already in that state |
| 400 | `invalid_body` | not `{ optOut: boolean }` exactly |
| 400 | `missing_idempotency_key` | header absent or malformed |
| 401 / 403 | — | no session / not a member session |
| 409 | `suppressed` | the address is on the suppression list; the portal renders text, not a control |
| 409 | `idempotency_conflict` | same key, different body |
| 429 | — | rate limit |
| 503 | `suppression_unavailable` | the suppression list could not be read — switching ON is refused rather than done blind |
| 503 | `idempotency_reservation_failed` | reservation store unavailable |
| 500 | `internal` | anything else |

`GET /api/portal/profile` returns `marketing: { state: 'on' | 'off_by_staff' |
'off_by_contact' | 'unsubscribed' }` on the session's OWN contact ONLY — never per contact
(FR-032: a portal user must not learn another contact's marketing state).

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
