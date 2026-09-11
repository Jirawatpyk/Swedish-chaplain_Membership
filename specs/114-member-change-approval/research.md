# Research — 114 Member Portal: Approval Workflow for Member Changes

**Phase 0 output** for `plan.md`. Every item below is a decision with its rationale and the
alternatives rejected. The inputs were (a) the spec's § Clarifications, (b) the panel report
`reviews/spec-review-panel-20260911.md` § "Unverified" (eight themes carried here as questions),
and (c) the code as read on 2026-09-11 (`file:line` where it matters). No `NEEDS CLARIFICATION`
remains in `plan.md` § Technical Context.

Legend: **D** = decision · **R** = rationale · **A** = alternatives rejected · **P** = panel theme closed.

---

## R1 — Owning bounded context: `src/modules/members`

**D**: The change-request aggregate, its use cases, repo, email adapter and audit events live in
`src/modules/members/` (`domain/change-request/**`, `application/use-cases/change-requests/**`,
`infrastructure/db/drizzle-change-request-repo.ts`), exported through the existing members barrel
(85 exports today).
**R**: A change request is a *proposal about a member record*; every write it makes on approval is a
`members`/`contacts` write through ports that already exist in this module
(`MemberRepo.updateFieldsInTx`, `ContactRepo.updateInTx`, `AuditPort.recordInTx`). A sibling
module would need to reach into those `*InTx` writers through the barrel *and* re-implement the
archived / erasure guards the module already owns (`member-self-update.ts:312` re-reads FOR UPDATE
inside the tx). The panel's #7 refutation confirmed module ownership is a plan decision, not a spec
one.
**A**: (1) new `src/modules/change-requests/` — cleaner boundary on paper, but it would be the first
module whose *only* purpose is to mutate another module's aggregate, and the tenant-scoped repo
must thread the same `tx` into `members` writers, which means importing `MemberRepo` from the
barrel and composing two modules' deps in `src/lib/` for one transaction. Rejected as ceremony
without a second consumer (Constitution X). (2) `src/modules/insights/` (it owns the timeline and
dashboard) — rejected: insights is read-model territory and must not write member rows.
**P**: theme 5 (module ownership).

## R2 — Persistence: two new tenant tables, no JSON blob on `members`

**D**: `member_change_requests` (one row per request) + `member_change_request_fields` (one row per
proposed field or address group, with `seen_value`, `proposed_value`, `outcome`, `applied_at`).
Both `tenant_id text NOT NULL`, RLS `ENABLE` + `FORCE` with the strict policy from migration 0209
(`USING/WITH CHECK tenant_id = current_setting('app.current_tenant', TRUE)`), both added to
`scripts/check-multi-tenant` `SCOPED_TABLES`. Migration `0300_member_change_requests.sql`,
journal `when: 1798543200000` (last is `1798543100000`; the +100000 rule from § Gotchas applies).
**R**: Per-field rows are what the per-field decision (spec FR-014/FR-016) reads and writes;
a JSON diff column would force every decision to rewrite the blob and would make "changed since
submitted" (FR-019) a client-side computation. Values are stored as `jsonb` (`seen_value`,
`proposed_value`) because an address group is a compound; scalar fields store a JSON scalar.
**A**: (1) a `pending_changes jsonb` column on `members` — rejected: one pending request *per
submitting person* (FR-008) does not fit a single column, and erasure scrub (FR-030) would have
to parse it. (2) reusing `audit_log` as the store — rejected: audit is append-only and must not
carry the live state machine; it records the events (R7).
**P**: theme 4 (one-pending-per-person constraint — see R3), theme 5 (DDL contract — see
`data-model.md`).

## R3 — Uniqueness: one *pending* request per submitting person, enforced by a partial unique index

**D**: `CREATE UNIQUE INDEX member_change_requests_one_pending_per_submitter ON
member_change_requests (tenant_id, submitted_by_user_id) WHERE state = 'pending'`. The submit use
case runs inside one `runInTenant` tx: `SELECT … FOR UPDATE` the submitter's pending row (if any)
→ mark it `withdrawn` / `replaced` → insert the new one. Two concurrent submits by the same person
serialise on the row lock or on the unique index (the loser retries once, then returns
`conflict`).
**R**: Spec FR-008 after clarify Q2. The index is the database-layer guarantee the panel asked for
(theme 4); the FOR UPDATE makes the replace-then-insert race-free without an advisory lock —
which stays reserved for its three documented namespaces (CLAUDE.md § Active Technologies).
**A**: `pg_advisory_xact_lock` per (tenant, submitter) — rejected: it would create a fourth
advisory namespace for a race a row lock + partial unique index already close.

## R4 — Decision atomicity: throw-to-rollback inside one `runInTenant`

**D**: `decideChangeRequest` opens exactly one `runInTenant(tenant, tx)`: re-read the request FOR
UPDATE (state must be `pending`; else `already_decided` with reviewer + outcome), re-read the
member FOR UPDATE (archived → `member_archived`; `erasure_requested_at` set → `member_erasing`),
re-validate every approved field against the then-current data (FR-006/FR-015), apply approved
member fields with `MemberRepo.updateFieldsInTx` and contact fields with `ContactRepo.updateInTx`,
write per-field outcomes + the decision row, `AuditPort.recordInTx` the decision event, and
`EmailPort.enqueueInTx` the member notification. Every refusal after the first write is a
`throw new UseCaseAbort(err)` — **never** `return err(...)` from inside the callback (memory
`err() inside runInTenant COMMITS`; `docs/code-conventions.md` § 4).
**R**: Spec FR-015 (all-or-nothing, decision recorded in the same step). The members module already
uses `UseCaseAbort` at 102 sites, including the archived re-check in `member-self-update.ts`.
**A**: calling the staff `updateMember` / `updateContactFields` use cases — rejected (panel #6):
they open their own transactions and emit `member_updated` / `contact_updated` audit rows
attributed to the *caller*, which would either double-audit or misattribute the applied change.
The change-request decision emits its own event (R7) and the row-level audit stays truthful:
proposed by the member, applied by the reviewer.
**P**: theme 4 (idempotency — the FOR UPDATE + state check makes a retried decision a no-op
returning the recorded decision; no idempotency-key store is needed because the request id is the
key).

## R5 — Transport: `/api/**` route handlers, never Server Actions

**D**: Member side — `POST /api/portal/change-requests` (submit), `GET /api/portal/change-requests`
(own + company-level history), `DELETE /api/portal/change-requests/current` (withdraw). Staff side —
`GET /api/admin/change-requests` (queue), `GET /api/admin/change-requests/[id]`,
`POST /api/admin/change-requests/[id]/decide`, plus `PATCH /api/admin/settings/member-changes`
(the tenant switch). Guards: `requireMemberContext` (portal) and `requireApiPermission` (staff)
from `src/lib/rbac.ts:292`; pages use `requirePagePermission` (`src/lib/rbac.ts:246`) so
`check:staff-page-guard` / `check:api-route-guard` see them.
**R**: `specs/001-auth-rbac/research.md` § 4.1 rejected Server Actions; the repo has zero
`'use server'` directives; route handlers inherit the proxy's CSRF Origin allow-list, the
read-only-mode 503 (FR-036) and the RBAC denial audit. The existing `PATCH /api/portal/profile`
stays for **Group A only** (R6).
**A**: extending `PATCH /api/portal/profile` to create requests when the setting is on — rejected:
the same verb would mean "saved" or "queued" depending on tenant state, and the F3 contract tests
(`tests/contract/portal/profile.test.ts`) pin its immediate-write semantics.
**P**: theme 7 (transport), panel #10 refuted-but-recorded.

## R6 — Closing the bypass: `PATCH /api/portal/profile` narrows to Group A when the gate is on

**D**: `memberSelfUpdate` gains a `gate: 'immediate' | 'approval'` input resolved from the tenant
setting. In `approval` mode the whitelist it accepts is **only** `primary_contact.preferredLanguage`
(the contact's own `preferred_language`, the email/notification locale); any Group B key is refused
with the existing `member_self_update_forbidden` audit (FR-001, FR-003 "recorded as a forged
self-service edit"). `PORTAL_SELF_UPDATE_*` constants split into `PORTAL_IMMEDIATE_FIELDS`
(Group A) and `PORTAL_PROPOSABLE_*` (Group B) in `domain/portal-self-update-fields.ts`, still
compile-time tuples (F3 FR-014a) with the parity test extended.
**R**: Panel theme (U3): the existing endpoint already writes phone/website/description; without
narrowing, the gate is decorative. Keeping the same file means the forgery guard and its audit
stay single-sourced.
**A**: deleting the PATCH endpoint — rejected: Group A (`preferredLanguage`) still needs an
immediate write and the flag-off path (FR-031) must stay behaviour-identical.
**P**: theme 6 (two language stores): `contacts.preferred_language` is the Group A field;
`members.preferred_locale` (`/portal/account#language`, `PreferredLocaleForm`) is untouched. The
portal edit form's language `<select>` moves to `/portal/account` beside `PreferredLocaleForm`
and posts to `PATCH /api/portal/profile` with `{ primary_contact: { preferredLanguage } }` only.

## R7 — Audit events: five new `audit_event_type` values, snake_case `member_id`, actor truth

**D**: `member_change_request_submitted`, `member_change_request_decided` (payload carries
`outcome: approved|partially_approved|rejected` + per-field outcomes as `fields: [{key, outcome}]`
— **no values**), `member_change_request_withdrawn` (payload `reason: member|replaced|erasure`),
`member_change_request_rate_limited`, `member_change_approval_setting_changed`. All emitted via
`AuditPort.recordInTx` on the same tx as the state change. Payload key is `member_id` (snake_case)
so migration 0009's trigger bumps `members.last_activity_at` on **submit/withdraw** (member
activity); the **decided** event carries `related_member_id` instead, so a staff decision does
not refresh the member's recency (the #337 rule). `actorRole` is the session role, never a
literal (`check:actor-role-truth`). Erasure-driven closure is emitted with the system actor the
erasure use case already uses.
Five places per event (CLAUDE.md § Gotchas): `src/modules/auth/domain/audit-event.ts`
`AUDIT_EVENT_TYPES` (pinned 37 → 42 in `tests/unit/auth/domain/audit-event.test.ts:39`), the
`auditEventTypeEnum` pgEnum + migration `ALTER TYPE audit_event_type ADD VALUE` (each in its own
statement; see 0292 for the pattern), the members `AuditPort` union, and `audit.eventType.*`
labels in EN/TH/SV (`audit-event-label-coverage` asserts Thai script).
**R**: Spec FR-025; the payload-without-values rule closes panel theme 1 (audit is the one store
erasure cannot reach — so it must never hold the PII the request rows hold).
**A**: reusing `member_self_updated` with a `mode` field — rejected: the timeline and the audit
viewer key their copy on `event_type`; a decision is not a self-update.

## R8 — Notifications: two new `notification_type` values; PII in `context_data` minimised

**D**: `member_change_request_submitted_staff` (one outbox row **per reviewer**, `to_email` = the
reviewer's address, `locale` = the reviewer's own `users.preferred_locale` falling back to the
tenant default) and `member_change_request_decided_member` (one row, `to_email` = the submitting
contact's email, `locale` = that contact's `preferred_language`). `context_data` carries **ids and
a field-key list only** (`request_id`, `member_id`, `field_keys[]`, `outcome`); the dispatcher
branch (`src/app/api/cron/outbox-dispatch/route.ts:141` switch) reads the request rows at send time
to render the diff. Migration `0300` adds both enum values (`ALTER TYPE notification_type ADD
VALUE`, own statements). Templates follow `infrastructure/email/email-verification-email.ts`
(hand-built HTML, `escapeHtml`, brand helpers) — no new dependency.
**R**: Spec FR-011/FR-012/FR-023/FR-024 (queued in the same unit of work, at-least-once). Reading
the diff at send time rather than copying it into `context_data` means the erasure scrub of the
request rows (R10) also blanks anything a not-yet-sent email would show, and a *sent* outbox row
(retained 90 days by `outbox-purge`) holds no names, phones or addresses — panel theme 1 closed
without a new outbox-cancel matcher.
**A**: one email to a shared mailbox — rejected by spec § Assumptions (no per-tenant mailbox
setting this round). Copying old/new values into `context_data` — rejected for the erasure reason
above.
**Coalescing (FR-011)**: the submit use case checks `member_change_requests.staff_notified_at` of
the request it replaces; if within 1 h, the new row inherits `staff_notified_at` and enqueues
nothing. The staff email link is `/admin/change-requests?submitter=<userId>` resolved server-side
to the current pending request — never a request id.

## R9 — Rate cap: counted from the durable table, not from Upstash

**D**: `SELECT count(*) FROM member_change_requests WHERE tenant_id = $1 AND submitted_by_user_id =
$2 AND submitted_at > now() - interval '24 hours'` inside the submit tx, before the insert; ≥ 10 →
`rate_limited` (HTTP 429 with `Retry-After` from the oldest row in the window, via
`rateLimitedJson` in `src/lib/rate-limit-helpers.ts:30`) + `member_change_request_rate_limited`
audit. No Upstash call on this path.
**R**: Spec FR-008 after panel U6: the bulk-action limiter fails **open** on an Upstash outage
(falls back to a per-process bucket a cold instance sees as empty) and CI smoke has no Redis; an
absolute cap must come from the same durable store as the requests. At SweCham's scale
(≤ 150 members) the count is a ~1 ms indexed read.
**A**: Upstash sliding window — rejected as above. A `submission_count` column — rejected: the
window is rolling; a count query over `(tenant_id, submitted_by_user_id, submitted_at)` index is
simpler and cannot drift.
**P**: theme 4.

## R10 — Erasure, retention, DSAR export

**D**: `eraseMember` step 2 (the atomic scrub tx, `erase-member.ts:322`) gains a `ChangeRequestScrubPort`
call: every request row of the member gets `seen_value`/`proposed_value` replaced with the erasure
sentinel (`domain/erasure-sentinels.ts`), `submitted_by_display` blanked, and any `pending` request
closed as `withdrawn` / `erasure`. Row counts and outcomes remain (FR-030). Retention: the rows carry
no `retention_years`; they are kept with the member row (never purged independently) — the audit
events they mirror are the 5-year record. The member DSAR export (`requestDataExport`,
`src/modules/insights`, via `src/app/api/portal/account/data-export/route.ts`) gains a
`change_requests` section scoped exactly as FR-029 (the requesting person's own requests +
company-level requests).
**R**: Spec FR-030, US4 AS6/AS7; the panel's theme 1/2 questions.
**A**: hard-deleting request rows on erasure — rejected: the *existence* of decided requests is part
of the accountability record (spec FR-030 "existence and outcome remain") and the dashboard/queue
counts must not shift retroactively.
**Guard**: the erasure contract test (`tests/contract/members/admin-events-erase-by-email.test.ts`
family) is extended with a row-level assertion that no `member_change_request_fields` row of the
erased member holds a non-sentinel value — the "table-scoped scrub guard" the panel noted is
table-scoped precisely so a new table must register itself; this is that registration.

## R11 — Tenant switch: a column on `tenant_member_settings`

**D**: `tenant_member_settings.member_change_approval_enabled boolean NOT NULL DEFAULT false`
(migration 0300). Read at request time by `resolveMemberChangeGate(tenant)` (cached per request);
written by `setMemberChangeApprovalEnabled` (admin-only, `members.write`), audited with
`member_change_approval_setting_changed { previous, next }`. Surface: a new card on
`/admin/settings/member-changes` (the settings hub at `src/app/(staff)/admin/settings/page.tsx`
lists categories; add one). SweCham is flipped ON by the operator after deploy.
**R**: Spec FR-031/US6; the table already exists for per-tenant member policy
(`member_number_prefix`, 0209) with RLS FORCE, so no new table for one boolean. Default `false`
matches the `auto_invoice_enabled` precedent (0274).
**A**: env flag only — rejected: a platform flag is not per-tenant (MTA+STD). A row in a new
`tenant_settings` table — rejected: no such table exists and one boolean does not justify it.
**Flag**: `FEATURE_MEMBER_CHANGE_APPROVAL` (zod boolean in `src/lib/env.ts`, default OFF; listed in
`.env.example` for `check:env-example`). Flag OFF ⇒ the gate resolver returns `immediate`
regardless of the tenant row and every new route returns 404 — the dark-ship pattern (108).

## R12 — Dashboard count + nav badge + metric

**D**: (1) A `NeedsAttentionItem` on the F9 home page (`src/app/(staff)/admin/(home)/page.tsx:273`
builds the list; `NeedsAttentionList` takes `{id,label,href,count}`) — the count is a **live**
`SELECT count(*), min(submitted_at)` from the request table at page render (like
`broadcastsAwaitingApproval`, "a plain DB count" per the page's own comment), not the cron
snapshot, so US6 AS3 holds immediately. (2) The staff nav item `nav.staff.changeRequests` under
the Membership section (`src/config/nav.ts:224`, `defineGuard('members.read')`) carries an
optional `badgeCount` resolved server-side in the staff shell — the nav config has no badge slot
today (panel theme 7); adding one optional field to the item type is the smallest change and stays
declarative. (3) Gauge `members.change_requests_pending_count{tenant}` +
`members.change_request_oldest_age_seconds{tenant}` in `membersMetrics` (`src/lib/metrics.ts`),
emitted by the existing `broadcasts-gauges` cron route generalised to a per-tenant gauges tick —
**no new cron**: `vercel.json` has 37 of the Pro plan's 40 jobs.
**R**: Spec FR-033/FR-037/SC-008; the cron budget is the binding constraint.
**A**: a dedicated `/api/internal/metrics/change-requests` cron — rejected for the budget reason;
polling from the nav — rejected (no realtime in scope).
**Alert threshold** (FR-037): `oldest_age_seconds > 7 days` warning, `> 14 days` page — both well
inside the 30-day data-subject-request clock; recorded in `docs/observability.md` § 14 (new).

## R13 — Review page decision UX: `ReasonConfirmationDialog` promoted to a shared shell component

**D**: The per-field table (all rows pre-selected) is a new client component
`ChangeRequestDecisionTable`; the confirming action opens
`src/components/shell/reason-confirmation-dialog.tsx` — the existing
`src/components/broadcast/reason-confirmation-dialog.tsx` moved to `shell/` with a re-export left at
the old path (its props already carry `reasonRequired`, `maxLength`, `namespace`, `finalFocus`).
The dialog's title/description/confirm label are computed from the selection ("Approve all 4" /
"Approve 3, reject 1" / "Reject all 4"), `reasonRequired = rejectedCount > 0`, `destructive =
rejectedCount > 0`. Focus starts on Cancel, spinner while running, stays open until the response
(ux-standards § 6.2/6.4). `finalFocus` returns the table's confirm button (memory: finalFocus on
EVERY dialog).
**R**: Spec FR-014/FR-034; ux-standards § 6.4 demands one contract, not a per-form dialog; the
broadcasts reject dialog already implements the reason textarea, counter and double-RAF focus.
**A**: a new dialog — rejected (§ 6.4). Per-row approve/reject buttons — rejected (spec Q3: one
confirming action).

## R14 — Validation parity: one shared field-rule set

**D**: A Domain module `domain/change-request/field-rules.ts` exports, per Group B key, the zod
rule **taken from** `buildMemberFormSchema` (company name, website, description, addresses) and
`asPhone` / the contact schema (name, phone, job title). Both the submit use case and the
approval-time re-validation (R4) call the same rule set; a unit test asserts the rule for each key
is reference-equal to the staff form's.
**R**: Spec FR-006 ("the validation that applies to a staff edit of the same field"); panel #8 found
the website rule already *diverges* between the staff and member paths and postal code has no rule
— parity must be a mechanism, not a sentence. The member path must not be stricter than the staff
path (US1 AS4's examples are limited to rules that exist).
**A**: duplicating the rules — rejected (the divergence panel #8 measured is exactly what
duplication produces).

## R15 — Timeline + portal visibility

**D**: The five audit events flow into `member_timeline_v` through its audit arm (`0192`, `WHERE
payload ? 'member_id' OR payload ? 'related_member_id'`) with no view change; the timeline repo's
i18n key `timeline.audit.<event_type>` gets EN/TH/SV copy. The portal timeline already reuses the
same `timelineList` with the member's own filter. The portal history page (`/portal/change-requests`)
and `GET /api/portal/change-requests` apply the FR-029 scope in SQL: `submitted_by_user_id = $me OR
scope = 'company'`.
**R**: Spec FR-026–FR-029; the panel's theme 2 (one contact must not see another's own-field
diff).
**A**: filtering in the component — rejected: the rows must never leave the server.

## R16 — Testing strategy (Constitution II)

- **Contract** (`tests/contract/portal/change-requests-*.test.ts`,
  `tests/contract/members/admin-change-requests-*.test.ts`): every route × role × flag state;
  429 shape; 404 when the flag is off; RBAC pins for `members.read` vs `members.write`.
- **Integration** (`tests/integration/members/change-requests-*.test.ts`, live Neon dev branch):
  two-tenant isolation both directions (Constitution I.3 — SC-009); same-submitter concurrent
  submit ×50 (exactly one pending); concurrent decide ×2 (exactly one decision); decision rollback
  when the second field's write fails (mock the contact repo to throw after the member write);
  erasure scrub assertion (R10); rate cap at 10 with the limiter absent.
- **Unit**: Domain 100% lines (state machine, field rules parity, outcome derivation); the four use
  cases (`submitChangeRequest`, `withdrawChangeRequest`, `decideChangeRequest`,
  `setMemberChangeApprovalEnabled`) pinned at 100% branches in `vitest.config.ts` (security-critical:
  PII write + RBAC).
- **e2e** (local only): member submits → staff decides partially → member resubmits; axe on every
  new surface at 320 px; TH + SV smoke.
- Each user story's first task is its RED acceptance test.

## R17 — i18n scope

~70 keys × 3 locales: `portal.changeRequests.*` (pending banner, diff table, withdraw, history,
statuses), `admin.changeRequests.*` (queue, filters, review page, decision dialog, settings card),
`nav.staff.changeRequests`, `audit.eventType.member_change_request_*` (5, with Thai script),
`timeline.audit.member_change_request_*`, `email.changeRequest.*` (two templates × 3 locales).
Dates render through `formatLocalisedDate` (BE display-only for `th-TH`).

## R18 — Checklist-gate closures (2026-09-11)

**D**: The 30 requirement-text gaps the six domain checklists raised are closed with defaults
consistent with R1–R17; the spec's Clarifications session "gap closure — AMENDMENT" is the index.
Three closures add design, all small: (1) `member_change_requests.outcome_acknowledged_at` +
`POST /api/portal/change-requests/[id]/acknowledge` — the last decision stays on the profile until
the submitter dismisses it (server-side, like the dashboard `insight-dismiss-button`), so a member
who was away still sees the outcome; (2) a `contact`-target row whose contact was removed/unlinked
after submission is reject-only (`undecidable: 'contact_removed'`), computed at review time — no
column, no new state; (3) the primary contact's first/last name joins the tax-affecting set, because
`MemberIdentitySnapshot.primary_contact_name` is built from it at issue (`issue-invoice.ts:765`).
Measured for the closures: no read-audit event type exists for member detail views (so change-request
reads are not audited either); staff `users.status` is `active | disabled` (never deleted); the buyer
block is snapshotted at *issue*, not at draft creation.
**R**: Each gap had one obvious default given the recorded decisions; opening a clarify round for
them would have cost a session for no new information.
**A**: leaving them to `/speckit.analyze` — rejected: tasks generated from a spec with known holes
are rewritten after analyze; closing first is cheaper.

## Carried to `/speckit.tasks` as verify-before-task items

- **V1** — `buildMemberFormSchema`'s website rule vs the portal `hasDangerousUrlScheme` refine:
  decide which is the canonical Group B rule (R14) by reading both before writing the parity test.
- **V2** — `broadcasts-gauges` cron route: confirm it can host a second module's gauges without
  breaking its `broadcasts_*` metric names (R12).
- **V3** — `outbox-dispatch` reads `context_data` only: confirm the dispatcher can take the tenant tx
  for the read-at-send of request rows (R8) — it already runs `runInTenant(payload.tenantId)` for
  `receipt_pdf_render`.
- **V4** — prod read-only count of `contacts.linked_user_id IS NOT NULL AND is_primary = false`
  (secondary contacts with a login) — 0 on 2026-09-10 (108 cutover), which makes the per-person
  scope (FR-029) vacuous until the secondary import; the tests must not rely on prod shape.

---

## Verified before tasks (2026-09-11, bridge session — T005 / T006 / T007)

### § V1 — canonical Group B validation rule (T005)

**Measured** (`update-member.ts:38-98`, `contact-crud.ts:84-109`, `member-form/schema.ts:95-140`,
`member-self-update.ts:44-66`):

- The **server** staff-edit rules are `updateMemberSchema` (company_name `trim().min(1).max(200)`;
  website `max(200).url().refine(!hasDangerousUrlScheme).nullable().optional().or('')`;
  description `max(2000).nullable().optional()`; address lines `max(200)` / sub_district, city,
  province `max(100)` / postal_code `max(20)`; billing_* the same shapes + billing_country
  `length(2)`) and `updateContactFieldsSchema` (first/last `trim().min(1).max(100)`; phone
  `max(20).nullable()` then `asPhone` in the use case; role_title `max(100).nullable()`).
- The **client** `buildMemberFormSchema` is a per-render FACTORY over translator functions
  (`tf`, `tv`): a new zod object every call, so no rule in it can be reference-shared with
  anything. It adds only localised messages and a bare-domain normaliser
  (`normalizeWebsiteUrl`, prefixes `https://`) ahead of the same `.url()` check.
- The **portal** immediate path (`member-self-update.ts`) validates website with the scheme
  refine but **without `.url()`** — this is the divergence the panel (#8) measured.

**Decision**: the canonical rule is the **server staff-edit schema**. FR-006 binds the member
path to "the validation that applies to a staff edit", and the server schema is the rule a staff
edit is actually held to; the client factory is presentation sugar over it. Mechanism (R14 — parity
is a mechanism, not a sentence): `domain/change-request/field-rules.ts` exports one zod rule per
Group B key (address groups as per-line rules), and `update-member.ts` + `contact-crud.ts` build
their Group B shape entries FROM those exports, so the parity test (T018) asserts
**reference-equality** (`toBe`) between `FIELD_RULES.<key>` and the staff schema's shape entry —
unwrapping `updateMemberSchema`'s `ZodEffects` (it ends in `superRefine`) via `innerType()`.
`normalizeWebsiteUrl` moves to the Domain file too so the portal change-request form can apply the
same bare-domain courtesy the staff form applies. Consequence for the portal: a Group B website
proposal must now pass `.url()` (the staff rule) — stricter than today's immediate path, exactly
as FR-006 requires; the flag-OFF immediate path is untouched.

**Company-name uniqueness**: NONE exists on any staff path — no zod rule, no repo check, no DB
unique index or constraint (`rg -i "company_name.*uniq|companyName.*unique|duplicate.*company"`
over `src/modules/members` + `drizzle/migrations` → 0 hits). Spec § Edge Cases "Company name
identical to another member's" is therefore satisfied vacuously: T036 / T051 call no uniqueness
check because a staff edit performs none. If one is ever added to the staff path it must be added
to `field-rules.ts` first, so the parity test drags the member path along.

### § V3 — dispatcher read-at-send under the tenant tx (T006)

**Measured** (`outbox-dispatch/route.ts:384-560` `dispatchReceiptPdfRender`, `:705-760` the
`invoice_auto_email` receipt-PDF gate, `:133-180` `buildPayload`):

- The dispatcher claims a row `FOR UPDATE SKIP LOCKED` inside ITS OWN `db.transaction` (owner
  role, no tenant GUC). Every tenant-scoped read then opens a **separate**
  `runInTenant(asTenantContext(row.tenantId), …)` scope — `receipt_pdf_render` for the render
  use case, the auto-email gate for `SELECT receipt_pdf_status FROM invoices`. Both first guard
  `row.tenantId` against `/^[a-z0-9-]{1,64}$/` (S9 closure) and permanent-fail a malformed value.
- `buildPayload(row)` is already `async`, switches on `row.notificationType`, and returns `null`
  for an unrenderable row; `null` is routed to the existing permanent-failure path with its own
  audit, so a missing request row does not vanish silently.

**Decision rule** (binding on T037 / T053): the two new arms render INSIDE
`runInTenant(asTenantContext(row.tenantId), (tx) => …)` — read `member_change_requests` +
`member_change_request_fields` (+ the member's company name / member number, the submitter's
current contact row for the decided-member email) through the tenant tx, build the diff at send
time, and return the payload. `context_data` carries **ids and field keys only**; copying names /
phones / addresses into the outbox row is NOT an allowed fallback (privacy CHK006/CHK011). A
request row that no longer exists (or a contact removed/erased for the member email) returns
`null` from the arm so the row takes the dispatcher's existing unrenderable-row exit, with the
reason (`request_gone` / `recipient_gone`) carried in the `email_dispatch_failed` audit payload.

### § V4 — prod shape the per-person scope depends on (T007)

**Measured 2026-09-11 (read-only, `--env-file=.env.production`, tenant `swecham`, counts only)**:

| count | value |
|---|---|
| contacts with a login that are NOT primary (`linked_user_id IS NOT NULL AND is_primary = false AND removed_at IS NULL`) | **0** |
| primary contacts with a login | 1 |
| members with a billing address set (`billing_address_line1 IS NOT NULL`) | **0** |
| members (not erased) | 150 |
| active users holding `members.write` today (`admin` / `super_admin`) | 3 |

Consequences: (1) the FR-029 per-person scope and the secondary-vs-primary refusal
(`company_fields_require_primary`) are exercised **only by seeded data** — T033 / T069 / T081 seed
a secondary contact with a login themselves and never rely on prod shape; (2) with 0 billing
addresses the `registered_address` row is tax-affecting for every SweCham member today (FR-019
"registered address is the buyer address when no billing address is set") — the review page will
show the flag on every registered-address proposal until members get billing addresses, which is
correct, not a bug; (3) the reviewer fan-out is 3 outbox rows per submission (≤ 5 assumed).
