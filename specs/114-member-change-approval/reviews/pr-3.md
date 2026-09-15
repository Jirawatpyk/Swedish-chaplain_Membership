# PR-3 — US6 (tenant switch · dashboard item · nav badge · gauges) review round

Branch `114-member-change-approval`. PR-3 range: `321d813ee..b83a9d4e8` — five implementation
commits:

| Commit | Slice |
|---|---|
| `43796ecb4` | US6 server — setting route, pending count, gauges, FR-038/039 guards |
| `467f7e7d9` | US6 UI — settings card, dashboard item, nav badge, i18n ×3, runbook |
| `3fdef4409` | PR-3 polish — OTel spans, 100 % branch pins, the PR-2 parked items |
| `7a78042ef` | US6 UX review closed — 2 HIGH, 5 MEDIUM, 6 LOW taken |
| `b83a9d4e8` | US6 e2e (T104) + the whole change-requests spec green on chromium |

Everything is still dark behind `FEATURE_MEMBER_CHANGE_APPROVAL` (default OFF, absent from
Vercel) and the per-tenant switch.

**The two PR-3 sections written before this round live at the end of `reviews/pr-2.md`**:
"PR-3 polish — the items parked in PR-2 (2026-09-15)" and "PR-3 US6 UX review
(enterprise-ux-designer, 2026-09-15)". They are the record of what `3fdef4409` and `7a78042ef`
changed and are not repeated here; this file covers the four read-only reviewers who ran on the
finished PR-3 tree.

## Round — four read-only reviewers (Opus), 2026-09-15

`security-engineer` (SEC-*), `pdpa-gdpr-compliance-officer` (P-*), `reliability-guardian`
(R-*), `i18n-translation-reviewer` (i18n) — concurrent, read-only. Every behaviour change below
was TDD'd: the RED run is quoted per item. Copy-only items ride `pnpm check:i18n`.

---

## Reliability (`reliability-guardian`)

### R-H1 — HIGH — TAKEN. The badge read blocked the staff shell on every page

`src/app/(staff)/admin/layout.tsx` awaited `readPendingChangeRequests` with no bound. The count
feeds `navBadgeCounts`, a prop of the CLIENT `<StaffSidebar>`, and the nav config it belongs to
carries Lucide icon FUNCTIONS that cannot cross the RSC boundary — so the map must be complete
before the sidebar element is created and `<Suspense>` does not fit (now stated in the layout's
docblock rather than left implicit). The pool bounds a query at `statement_timeout 5s` +
`connect_timeout 3` (`src/lib/db.ts`), so a slow Neon could add ~8 s to the TTFB of every
`/admin/**` page for a number in the sidebar.

**Fix**: `readPendingChangeRequestsForNav(tenant, role)` in `src/lib/pending-change-requests.ts`
races the read against `NAV_BADGE_READ_TIMEOUT_MS = 1_500`; past the deadline the badge is
`unavailable` (no badge) and ONE line is logged under `errorId: 'M114.nav.badge_timed_out'`
(with `timeoutMs`). The timer is cleared in a `finally`. The DASHBOARD keeps the full read — it
is one page an operator opened, not a shell on every route.

**RED** (`tests/unit/lib/pending-change-requests.test.ts`, fake timers):
`TypeError: readPendingChangeRequestsForNav is not a function` — 9 failed / 9.
**GREEN**: 9 passed, including "a read still running at the deadline → unavailable + ONE
`M114.nav.badge_timed_out`", "a read that resolves INSIDE the deadline answers the summary",
"a read FAULT inside the deadline is the read-failed id, not the timeout id" (the two ids stay
distinguishable) and "flag OFF stays hidden" (a gate that answers without a query is not
time-boxed into a fault).

Files: `src/lib/pending-change-requests.ts`, `src/app/(staff)/admin/layout.tsx`,
`tests/unit/lib/pending-change-requests.test.ts`.

### R-H2 — HIGH — TAKEN. A read fault rendered "all clear"

`readPendingChangeRequests` answered `null` for BOTH "hidden by design" (flag off / no
`members.read`) and "the read faulted", and the dashboard drops items whose count is 0 — so a
Neon blip rendered the **all-clear empty state** ("All clear — nothing needs attention right
now.") while the FR-037 clock ran on a queue nobody could see. The queue page deliberately
throws in that case; the dashboard silently lied.

**Fix**: a discriminated result `{ kind: 'ok'; summary } | { kind: 'hidden' } |
{ kind: 'unavailable' }`. The dashboard renders the house section-failure shape for
`unavailable` — `InlineAlert tone="destructive" role="status"` (`status`, not `alert`: the page
rendered, one item did not — the UX I9 precedent is
`admin/members/[memberId]/_components/member-change-requests-section.tsx`) — through a new
optional `unavailable` prop on `<NeedsAttentionList>` that also **suppresses** the all-clear
state while it is present. `ok` with count > 0 keeps the item; `hidden` renders nothing. The nav
shows no badge for `hidden` and `unavailable` alike. New key
`admin.dashboard.needsAttention.changeRequestsUnavailable` (EN + TH + SV).

**RED** (`tests/unit/app/admin/dashboard/needs-attention-change-requests.test.tsx`): 6 failed /
9 — the fault case still contained "All clear — nothing needs attention right now."
**GREEN**: 9 passed. The fault case now asserts the alert, its `data-testid`, `role="status"`
and the ABSENCE of the empty-state copy; a `Result` error (not only a throw) is pinned as the
same surface; flag OFF is pinned as `hidden` (empty state, no alert, no query).

Files: `src/lib/pending-change-requests.ts`, `src/app/(staff)/admin/(home)/page.tsx`,
`src/components/dashboard/needs-attention-list.tsx`, `src/i18n/messages/{en,th,sv}.json`, the
two unit tests named above (+ the two sibling dashboard suites, mock updates only).

### R-M1 — MEDIUM — TAKEN. `FOR UPDATE` cannot lock a row that does not exist

`drizzle-tenant-member-change-settings-repo.ts` `setApprovalEnabledInTx` opened with
`SELECT … FOR UPDATE`. A tenant provisioned before the 0209 seed has **no**
`tenant_member_settings` row, so the lock held nothing and two concurrent PATCHes both read
`previous = false` — one of them then audits
`member_change_approval_setting_changed { previous: false, next: true }` next to a stored
`false`. That is the audit-truth invariant this repo guards everywhere else.

**Fix**: `INSERT … ON CONFLICT (tenant_id) DO NOTHING` first (seeded with the CURRENT value
`false`, the FR-031 new-tenant default — never `enabled`, so `previous` stays truthful on both
the create and the update path; the 055 prefix column takes its DEFAULT), then
`SELECT … FOR UPDATE`, then the UPDATE. A concurrent writer now queues on the unique index.

**RED** (live Neon `dev`, by path,
`tests/integration/members/change-requests-tenant-isolation.test.ts`): the two-overlapping-
transaction case failed with `expected false to be true` on `secondPrevious` — the second writer
DID block (the `secondDone === false` assertion held while tx1 was open, so the transactions
really overlapped) and still read the pre-tx1 world.
**GREEN**: 9 passed in that file (46.2 s).

Also added in the same block, closing **[SEC test gap 1]**: the Constitution I.3 cross-tenant
case for this write path — flipping tenant A leaves tenant B row-less and its gate `immediate`,
and B's own flip does not disturb A.

Files: `src/modules/members/infrastructure/repos/drizzle-tenant-member-change-settings-repo.ts`,
`tests/integration/members/change-requests-tenant-isolation.test.ts`.

### R-M2 — MEDIUM — TAKEN (docs). The runbook used outbox statuses that do not exist

`outbox_status` is `pending | sent | permanently_failed`
(`src/modules/auth/infrastructure/db/schema.ts` ~738 — verified), and the erasure scrub
**DELETEs** the still-pending F114 rows (`cancelPendingForMemberInTx`,
`outbox-cancel-adapter.ts:99` — a `DELETE … RETURNING`), so there is no `cancelled` row to find.

**Fix**: the "why no email" table row now says `permanently_failed`; the dispatcher-failures
section names the three-value enum and states that **no row at all** is the expected state after
an erasure — "do not go looking for a cancelled one". No test (documentation).

File: `docs/runbooks/member-change-requests.md`.

### R-M4 — MEDIUM — TAKEN. The gauges zero-fill scan grew with history

`SELECT DISTINCT tenant_id FROM member_change_requests` in the members gauges block is an
index-only scan of the whole request table every 5 min — a cost that grows with RETENTION rather
than with the number of tenants.

**Fix**: the tenant set is now `SELECT tenant_id FROM tenant_member_settings` (one row per
provisioned tenant) ∪ the pending `GROUP BY` keys — the union keeps a tenant with pending rows
but no settings row (a pre-0209 seed, i.e. exactly R-M1's tenant) observed.

**RED** (`tests/contract/broadcasts/cron-broadcasts-gauges.contract.test.ts`): the new
query-shape case failed —
`expected 'SET LOCAL statement_timeout = \'10s\'…' to match /FROM\s+tenant_member_settings/i`.
The case runs the REAL transaction callback against a recording `tx` double (new `recordMembersTx`
+ `sqlText` helpers), because a mock that only returns rows cannot tell a settings read from a
`DISTINCT` scan.
**GREEN**: 20 passed. The case also asserts the union in both directions (a provisioned-quiet
tenant zero-filled, a settings-row-less tenant with pending rows still counted).

Files: `src/app/api/internal/metrics/broadcasts-gauges/route.ts`, the contract test,
`docs/observability.md` § 27.1.

### R-M5 — MEDIUM — **PREMISE REFUTED**; the naming half TAKEN

The finding held that `patchesOf`'s `default` arm in `decide-change-request.ts` (~line 266,
`v8 ignore`) is reachable from stored rows, because `field_key` is TEXT + CHECK in 0300 rather
than a Domain-owned enum — leaving a 422 with `issues: []` and a request that can never be
decided.

**It is not reachable, and that was measured, not argued.** Two cases were written to reach it
(`tests/unit/members/change-requests/decide-change-request.test.ts`, "a stored field_key outside
the Domain union (PR-3 R-M5)") feeding a row with `field_key: 'legacy_fax'` through the
in-memory repo. Both passed on the unmodified source:

- **approving** it is refused at step 6, one step EARLIER than the finding assumed:
  `validateProposal(proposalOf(approvedFields))` runs the approved values through
  `proposalSchema`, which is `.strict()` at every level (`field-rules.ts:113/126/138/157/164`),
  so the unrecognised key is refused with an issue that NAMES it — the test asserts the issue
  list is non-empty and contains `legacy_fax`, and that the row is still `pending`;
- **rejecting** it never enters `approved` at all, so the request CAN be decided and the queue
  can be cleared — the opposite of the "can never be decided" claim.

So the `v8 ignore` stands (removing it would break the file's pinned 100 % branch threshold with
no input able to reach the arm), and its comment now cites those two tests instead of asserting
unreachability without evidence.

**Taken anyway**: the arm no longer answers `issues: []`. It returns
`namedIssue([String(key)], 'unknown_field')`. The file's own rule — "The 422 names the field the
reviewer must reject (round 6, silent-failure #22) — never an empty `issues`" — was stated three
lines below an arm that broke it; defence-in-depth arms are held to it too.

Scoped coverage after the change: `decide-change-request.ts` and
`set-member-change-approval-enabled.ts` both **100 / 100 / 100 / 100**
(`vitest run tests/unit/members/ tests/contract/members/ tests/contract/portal/ --coverage
--coverage.include=<each file>`, 229 files / 2,120 tests).

Files: `src/modules/members/application/use-cases/change-requests/decide-change-request.ts`,
its unit test.

### R-L1 — LOW — TAKEN (docblock). "logged once" was not true

`src/lib/change-request-attempt-bucket.ts` said the Upstash fallback is "logged once per
refusal-or-not"; it logs per CALL, and the limiter logs its own line for the same outage. The
helper's log is KEPT — it carries the caller's `errorId`, i.e. WHICH route's bucket was degraded,
the one dimension a shared literal would destroy (T107) — and the docblock now says so.

### R-L2 — LOW — **NOT TAKEN**, accepted and recorded

`/admin` runs the pending-count read twice: once in the staff layout (the nav badge) and once in
the page (the dashboard item). Both are the same single indexed `count/min` query, they are
independent RSC trees, and the alternative (hoisting into a request-scoped cache, or passing
through context) buys one query on one route at the cost of a new shared-state mechanism —
Principle X. Note that after R-H1 the two reads no longer even have the same deadline, which is
deliberate: the layout's is time-boxed, the page's is not.

### R-L3 — LOW — TAKEN. `?cursor=` (empty) silently showed page one

`one()` maps an EMPTY value to `undefined` BEFORE the strict cursor rule sees it, so
`?cursor=` took the lenient path the page docblock explicitly forbids ("a malformed cursor is a
404, never page one silently") — the "you have seen the whole queue" lie that rule exists to
prevent. There was no unit or contract test for this page (`grep -rl "change-requests/page"
tests/unit tests/contract` → nothing), so one was written.

**Fix**: a second reader, `oneRaw()`, without the empty→undefined collapse, used for the cursor
alone; `z.string().min(1)` then refuses `''` and the page 404s. The lenient filters are
untouched.

**RED** (new `tests/unit/app/admin/change-requests-queue-cursor.test.ts`): 2 failed / 6 — both
empty-cursor cases resolved to a rendered page-one tree instead of `notFound()`.
**GREEN**: 6 passed. The file also pins the non-mutants: a well-formed cursor is passed straight
through (the refusal is not a blanket 404), no cursor reads with `cursor: null`, an over-long
cursor is still refused, and an empty value on a LENIENT filter (`state=`) still drops only
itself — so the leniency split cannot be "fixed" away in either direction.

### R-L4 — LOW — TAKEN (docblock). "no-op" was wrong about the write

`setMemberChangeApprovalEnabled`'s docblock called the unchanged path a no-op. The upsert DOES
run and DOES stamp `updated_at`; what is skipped is the AUDIT row, because the trail records
transitions, not clicks. Reworded, and the two outcome fields' JSDoc with it.

### R-L5 — LOW — TAKEN. The no-op still showed a success toast

`approval-switch.tsx` toasted on every 200, including the server's `changedAt: null` (the stored
value already matched). "Approval switched on" then claims a change the audit trail does not
record — two admins on the same card, or a double-click, both read it.

**Fix**: the toast fires only when `changedAt` is present. The visible state line already carries
the value, so the no-op needs no announcement (and UX M3 already made the toast the single
announcement).

**RED** (`tests/unit/members/presentation/approval-switch.test.tsx`): 1 failed / 11 —
`expected "spy" not to be called at all, but it was called once` with
`"Approval switched on. New member changes now wait for a decision."`.
**GREEN**: 11 passed; a second case pins that a REAL change still toasts exactly once, so the
guard cannot be widened into "never toast".

---

## Security (`security-engineer`)

### SEC-1 — MEDIUM — TAKEN. The broadcasts 500 hid the members gauges

In `src/app/api/internal/metrics/broadcasts-gauges/route.ts` the broadcasts catch `return`ed the
500 BEFORE the members block, while the PR-3 docblock claimed the two halves were independent
both ways. A broadcasts outage therefore took the FR-037 age gauge with it — the one alert whose
threshold doubles as the 30-day data-subject-request backstop, blind for the duration of an
unrelated incident.

**Fix**: the broadcasts catch sets `broadcastsGaugesOk = false` and continues (every row array
stays empty, so no broadcasts sample is invented and the existing "no metrics emitted on a 500"
assertions still hold); the members block always runs; the tick answers **500** with
`error: 'query_failed'` at the END, and the body carries an independent OK flag per half. The
log names are unchanged.

**RED** (contract test): the replaced case expected `dbTransactionMock` called once —
`expected "spy" to be called 2 times, but got 1 times`, i.e. the members half was never reached.
**GREEN**: 20 passed. The case now asserts members gauges emitted, status 500,
`broadcastsGaugesOk: false`, `membersGaugesOk: true`, no broadcasts sample, and the unchanged
`cron.broadcasts_gauges.query_failed` log; a companion case pins `broadcastsGaugesOk: true` on a
healthy tick.

Documented in `docs/observability.md` § 27.1 (alert on each flag separately — a 500 no longer
implies stale members series) and § 27.3 (a new `broadcastsGaugesOk = false` row).

### SEC-2 — MEDIUM — TAKEN. The no-server-actions guard did not read the settings UI

`tests/unit/architecture/change-requests-no-server-actions.test.ts` scanned six trees; the US6
settings UI (`src/app/(staff)/admin/settings/member-changes` — page + loading + error + the
switch that PATCHes the tenant-wide gate) was not one of them. It is the surface where a
`'use server'` would matter most: it would flip the gate outside the CSRF Origin allow-list, the
in-route READ_ONLY_MODE gate and the RBAC denial audit at once.

**Fix**: the tree added (32 source files across seven trees, floor raised 10 → **30**), plus a
third positive control — every `SCANNED_TREES` entry must EXIST on disk. The `existsSync` skip
was written for trees a later slice would land; once every slice has landed it is pure risk,
because a renamed tree drops out of the scan while the remaining trees still clear the floor.

**Mutant-proven**: renaming the settings entry to `…member-changes-RENAMED` fails **2** tests —
`these trees are in SCANNED_TREES but not on disk: …` AND the floor (`at least 30 source
files`). Reverted; 35 passed.

### SEC-3 — MEDIUM — TAKEN. The errorId guard could not see the attempt-bucket call sites

`tests/unit/architecture/change-requests-error-id.test.ts` collected `errorId:` literals only.
Four routes hand their prefix to `refuseWhenAttemptsExhausted({ errorIdPrefix })`, which appends
`.attempts_exhausted` / `.attempt_bucket_fell_back` and logs it — so the id that reaches the log
appears nowhere in the route as an `errorId:` literal, and a route passing a NEIGHBOUR's
`ERROR_ID` const was invisible to rules 2 and 3. That is the F8 defect exactly (one hardcoded
id, 24 callers); the only difference is that the literal travels as an argument.

**Fix**: `collectErrorIdPrefixes()` collects `errorIdPrefix: '…'` and
`errorIdPrefix: <NAME>_ERROR_ID`, resolving through the SAME `consts` map (factored out as
`constsOf`), and the per-file test feeds `[...ids, ...bucketPrefixes]` into the SAME
`violations()` — extended so a prefix matches its route by EQUALITY (the helper supplies the
arm). A prefix is shape-checked at three segments, an `errorId` at four.

**Positive controls**: a fixture where the prefix is a neighbour's const is reported as a
violation and the route's own const is not; the bare-literal form is collected; an unresolvable
const surfaces as `<unresolved:MISSING_ERROR_ID>` rather than vanishing; and a second control
asserts the four route files that actually carry a bucket prefix are found on disk (the parse
cannot go vacuous).

**Mutant-proven**: changing `current/route.ts` to `errorIdPrefix: 'M114.portal.submit'` fails —
`portal/change-requests/current/route.ts logs an id that names another route: expected
[ 'M114.portal.submit' ] to deeply equal []`. Reverted; 15 passed.

### SEC-4 — LOW — TAKEN. Two resolutions of the same request could disagree

`src/lib/pending-change-requests.ts` called `resolveTenantFromRequest()` with **no request**,
which cannot see the `X-Tenant` override, while the settings page uses
`resolveTenantFromHeaders(await headers())`. The override is refused in production, so this is
not a prod leak — but a helper resolving its own tenant differently from the page that calls it
is the class Constitution I forbids, and it made the e2e throwaway-tenant fixtures read the
deployed tenant's count.

**Fix**: the helper takes a `TenantContext` from the caller. The staff layout and the dashboard
both resolve it the settings page's way. The dashboard's OTHER reads move to the same resolution
(`resolveTenantFromHeaders`), so the page has exactly one answer about which tenant it is.

**GREEN**: pinned in the helper test ("the CALLER tenant" — `buildChangeRequestDeps` is asserted
to receive the passed context); the three dashboard suites gained the `next/headers` +
`resolveTenantFromHeaders` mocks (28 passed).

### SEC-5 — LOW — TAKEN. The gauges emitted while the platform flag was OFF

While `FEATURE_MEMBER_CHANGE_APPROVAL` is off the queue routes 404, so a retained request is one
nobody can decide — and the age gauge would page "> 14 d" at an operator with no action
available.

**Fix**: the pending scan is skipped and both series are FORGOTTEN per tenant via a new
`membersMetrics.changeRequests.forgetGauges(tenantId)` in `src/lib/metrics.ts` (mirroring
`forgetDispatchFailureRate`, deleting both labels from `gaugeValues`), so no value can latch
across a flag flip. The body says `membersGaugesSkipped: 'flag_off'` and `membersGaugesOk` stays
`true` — nothing failed. Absence, not a zero: a 0 would assert "the queue is empty", a different
fact.

**Reading recorded**: B5 said "skip the members queries"; A4 (R-M4) defines the members tenant
set as `tenant_member_settings` ∪ the pending keys. Forgetting a label set requires knowing it,
and the broadcasts `observed` set is a different set (a tenant can have change requests and no
broadcasts row). So the dark path runs the ONE tiny provisioned-tenant read that A4 introduced
and skips the pending scan — the expensive one, and the one whose numbers are meaningless while
dark. The contract test asserts the pending scan is absent from the statements actually issued.

**RED**: `expected { ok: true, …(14) } to match object { membersGaugesSkipped: null }` (the key
did not exist) plus the flag-off case's statement assertions.
**GREEN**: 20 passed; both states pinned (flag OFF → no pending scan, `forgetGauges` per tenant,
no `pendingCount`/`oldestAgeSeconds`; flag ON → nothing forgotten, `membersGaugesSkipped: null`).
Documented in `docs/observability.md` § 27.1 + § 27.3 and the runbook's Alarm 4 (a new cause 4:
`flag_off` is not a fault).

### SEC-6 — LOW — TAKEN (comment). The filter-bar docblock described a literal action

`queue-filters.tsx` said `action="/admin/change-requests"`; the code is `action={pathname}`
(`usePathname()`), which is framework-supplied and same-origin by construction — no open-redirect
surface. The docblock now describes the code and says why the dynamic value is the safer one.

---

## Privacy (`pdpa-gdpr-compliance-officer`)

### P-H1 — HIGH — TAKEN. FR-040 RoPA ordering

The PR-3 card lets any `members.write` holder switch approval ON in one click, while
`quickstart.md` § 3 step 4 and rollback matrix row 1 still described the pre-PR-3 world ("one SQL
statement on `tenant_member_settings…`, record who ran it — no audit row exists yet"). Read in
order, the cutover could put the switch before the record of processing.

**Fix**:

- **step 4 rewritten** to the audited card (`/admin/settings/member-changes`, `members.write`,
  one `member_change_approval_setting_changed { previous, next, actor_role }` row), stating
  explicitly that **step 3 (RoPA) is a precondition of step 4, not a follow-up** (FR-040), that
  the SQL path is now break-glass only and produces no audit row, and that switching OFF and
  later back ON is another switch-ON;
- **rollback matrix row 1 rewritten** to the card, with the same FR-040 note on reversing it;
- **the T102 pre-flip gate row marked CLOSED in PR-3**, with the flag-OFF gauge behaviour noted
  so "no data" before the flip is not read as a broken emitter;
- **step 5** now names the dashboard row + nav badge and drops the "no emitter until T102";
- **one clause added to `admin.settings.memberChanges.cardDescription`** (EN / TH / SV): "Before
  switching on for a chamber, its record of processing must list this activity — see the cutover
  runbook." The operator meets FR-040 where the switch is, not only in a spec file;
- **a Rollback paragraph added to `docs/runbooks/member-change-requests.md`**: switching back ON
  is a switch-ON, FR-040 applies again in full, and rolling the setting off does not retire the
  RoPA entry.

**No confirm-on-ON dialog** — decision recorded. The consequence of switching ON is that member
edits start queueing; nothing is destroyed and the state line + the card description already
carry the precondition, so a second modal would be the "are you sure you want to configure this
setting" pattern the UX playbook rejects. The switch-OFF confirmation stays (it names the
pending count, UX H1).

`pnpm check:i18n` OK — 5,531 keys × 3 locales.

### P-M1 (= R-M3) — MEDIUM — TAKEN (docs). Alarm 3 described a limiter that does not exist

The runbook's last Alarm-3 paragraph called the bucket "per-IP / per-session" and named
`M114.portal.*.rate_limited`. Neither exists: it is keyed per **tenant + user**
(`src/lib/change-request-attempt-bucket.ts`), and it logs `*.attempts_exhausted`.

**Fix**: the paragraph now states the real key, the two sizes (10 / 10 min on the two by-id
portal reads, where it bounds the `member_cross_tenant_probe` row a miss writes; 60 / 10 min on
submit and withdraw), the grep (`*.attempts_exhausted`, each route naming itself), the metric
reason (`attempt_throttled`, vs `rate_limited` for the durable cap alone), the Upstash fallback
line (`<prefix>.attempt_bucket_fell_back`), and the triage reading — a sustained
`attempt_throttled` rate from one tenant is enumeration, a sustained `rate_limited` rate is one
member re-submitting.

### P-M2 — **NOT A FINDING** (verified by the coordinator). Recorded

`member_change_requests.tenant_id` is the text slug, not a uuid: migration 0300 line 53, and the
e2e seed inserts `'swecham'`. No change.

### P-L1 — LOW — TAKEN (docs). The reviewer SQL pulled staff emails

Alarm 1 cause 2 selected `id, email, role, status` from `users` to answer whether an active
reviewer EXISTS — a question that needs no address, and the answer lands in a terminal and a
paste buffer.

**Fix**: `SELECT id, role, status`, with the reason stated, and the runbook points at
`/admin/users` for identifying and acting on the people (the same list, under the RBAC + audit
surface).

### P-L2 — LOW — TAKEN (docs). Why the span-redaction claim holds

`docs/observability.md` § 27.5 now states that no SQL text or bind parameter can reach the trace
backend because `instrumentation.ts` (repo root) calls `registerOTel({ serviceName })` and
nothing else — **no pg / database instrumentation is registered**, so there is no
auto-instrumented statement span to leak a proposed value into (verified against the file). With
the standing instruction: if database instrumentation is ever added, leave
`enhancedDatabaseReporting` OFF — it attaches statement text and parameters to every span,
outside every filter that section describes.

---

## i18n (`i18n-translation-reviewer`) — all items taken

Line-scoped edits to `src/i18n/messages/{th,sv}.json`; EN unchanged except the FR-040 clause in
`cardDescription` (P-H1). CRLF preserved. `pnpm check:i18n` OK — 5,531 keys × 3.

| # | Key | Change |
|---|---|---|
| HIGH | TH `admin.changeRequests.filters.resultCount` | `กำลังแสดง # คำขอ` → `กำลังแสดงคำขอ # รายการ` (noun + number + classifier; `คำขอ` is not a classifier) |
| HIGH | TH `…filters.resultCountMore` | `กำลังแสดง {count} คำขอแรก` → `กำลังแสดงคำขอ {count} รายการแรก` |
| M1 | SV `admin.dashboard.needsAttention.changeRequests` | `(äldsta {days, plural, =0 {inkom idag} one {inkom för # dag sedan} other {inkom för # dagar sedan}})` — `idag` per the corpus, and an age now reads as an age rather than a bare number |
| M1 | TH same key | `(รายการเก่าสุด{days, plural, =0 {เข้ามาวันนี้} other {รอมาแล้ว # วัน}})` — no space before the ICU argument, so the sentence reads naturally |
| M2 | SV `admin.settings.memberChanges.confirm.cancel` | `Behåll godkännandet på` → `Behåll godkännandet påslaget` |
| M3 | SV `admin.settings.memberChanges.pageDescription` | `i sin egen post` → `i sin egen medlemspost` |
| L4 | SV `nav.staff.changeRequestsBadge` | `väntande` → `som väntar` (the badge reads inside the link's accessible name, "Ändringsbegäranden 3 som väntar") |
| L5 | SV `dataExport.loadFailed` | en dash → em dash (house punctuation) — no `i dag` occurrence in this string |

EN is untouched by the table above, so the US6 e2e block
(`tests/e2e/change-requests.spec.ts`, which asserts `state.on` / `state.off`, `switchLabel` and
`/^Switch off \(\d+\)$/`) is unaffected; `cardDescription` is not asserted there.

---

## Security checklist sign-off (`checklists/security.md`, CHK001–CHK028)

Signed by `security-engineer` on the PR-3 tree, 2026-09-15: **CHK001–CHK028 PASS**, with two
notes, both closed in this round.

| Item | Subject (abridged) | Verdict |
|---|---|---|
| CHK001 | authorization stated for every new surface | PASS |
| CHK002 | seeing (`members.read`) vs deciding (`members.write`) | PASS |
| CHK003 | denial semantics per surface (flag OFF → 404, wrong role → 403 + `permission_denied`) | PASS |
| CHK004 | a portal caller may act only on their own contact record | PASS |
| CHK005 | who may withdraw (only the submitting person) | PASS |
| CHK006 | reviewer eligibility stated for a future role gaining `members.write` | PASS |
| CHK007 | both isolation layers named for the two new tables | PASS — **note 1** |
| CHK008 | the two-tenant integration test covers reads AND decisions, both directions | PASS — **note 1** |
| CHK009 | the cross-tenant probe audit event named | PASS — **note 1** |
| CHK010 | the reviewer-enumeration read identified as the one cross-tenant read | PASS — **note 1** |
| CHK011 | the 10 / 24 h cap fully specified | PASS |
| CHK012 | abuse beyond one person (many portal contacts) | PASS |
| CHK013 | reason/note bounded and their rendering rule stated | PASS |
| CHK014 | proposed values validated by the same rule as a staff edit | PASS |
| CHK015 | forged submissions refused and audited | PASS |
| CHK016 | CSRF / transport: route handlers under the proxy Origin allow-list, never Server Actions | PASS — **note 2** |
| CHK017 | `Idempotency-Key` semantics for submit | PASS |
| CHK018 | member-facing surfaces never expose the reviewer's identity | PASS |
| CHK019 | per-person portal scope | PASS |
| CHK020 | staff notification contents bounded | PASS |
| CHK021 | the staff-email deep link resolves server-side to the person | PASS |
| CHK022 | all five audit events named; payloads carry ids/keys/outcomes only | PASS |
| CHK023 | staff-read auditing — the omission is deliberate and stated (FR-026) | PASS |
| CHK024 | attribution: proposed by the member, applied by the reviewer | PASS |
| CHK025 | `member_id` vs `related_member_id` payload-key rule | PASS |
| CHK026 | no dead self-review guard can be reintroduced | PASS |
| CHK027 | a deactivated reviewer keeps the `decided_by` attribution | PASS |
| CHK028 | flag-OFF behaviour for data already written | PASS — see SEC-5 |

**Note 1 (CHK007–CHK010, the reviewer's words: "PASS w/ note — two layers present + RLS FORCE verified; asks for a cross-tenant assertion of the setting write, test gap #1")** — the two-tenant integration test covered every PR-1/PR-2 use case but NOT
the US6 tenant-SETTING write path, which is the one write that changes what every other surface
does. Closed with R-M1's cross-tenant case
(`tests/integration/members/change-requests-tenant-isolation.test.ts`, live Neon): A's flip
leaves B row-less and its gate `immediate`, and B's own flip does not disturb A.

**Note 2 (CHK016, the reviewer's words: "PASS but weakly guarded — the guard exists but does not cover the new page tree, finding #2")** — the FR-038 "never a Server Action" guard did not read the settings UI
tree, so the requirement was stated but unenforced on the newest staff surface. Closed with
SEC-2 (tree added, floor 30, on-disk existence control, mutant-proven).

**Provenance**: the verdict column is the reviewer's own (CHK001–006 PASS · 007–010 PASS w/ note · 011–017 PASS, 016 "weakly guarded" · 018–021 PASS · 022–025 PASS · 026–028 PASS with the SEC-5 exception); the subject column is abridged from `checklists/security.md` by the coordinator.

## Privacy checklist items signed (`checklists/privacy.md`)

| Item | Subject | Verdict |
|---|---|---|
| CHK002 | purpose of each store bounded (request rows / outbox / audit) | **SIGNED** — unchanged by PR-3; the gauges added in PR-3 read counts and a MIN timestamp only, no new store and no new purpose |
| CHK005 | audit payloads carry ids, keys, outcomes — never values or reason text; `reason_length` in place of the reason | **SIGNED** — re-verified across the five events, including the US6 `member_change_approval_setting_changed { previous, next, actor_role }`, which carries no member key at all |
| CHK008 | log hygiene for the new use cases and routes | **SIGNED** — the PR-3 additions log `errorId`, `requestId`, `tenantId` and (new) `timeoutMs` only; § 27.5 now also states why TRACES carry no statement text (P-L2) |
| CHK019 | RoPA / DPIA named as deliverables | **CLOSES with P-H1** — FR-040 was named in the spec and step 3 of the cutover, but the ordering was only implicit and the card gave a one-click path past it. Now: step 3 is stated as a precondition of step 4, the rollback matrix says reversing layer 1 is a switch-ON, the runbook repeats it, and the card's own description carries it in all three locales |

---

## Gates at this tree (foreground, 2026-09-15)

| Gate | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm lint` (full) | exit 0 |
| `pnpm check:i18n` | OK — 5,531 keys in all 3 locales |
| `pnpm check:layout` | OK — 136 page/loading files, pairs consistent |
| `pnpm check:audit-events` | OK — F5 count 20; F9 enum ↔ taxonomy 16 match |
| `pnpm check:staff-page-guard` · `check:api-route-guard` · `check:actor-role-truth` · `check:authorization-role-reads` | OK (51 pages · 124 routes · 1,818 files 0 fabricated · 390 files 0 unmarked) |
| `vitest run tests/unit/{members,lib,app/admin,architecture,nav,components}/` | **437 files / 4,370 tests passed** |
| `vitest run tests/contract/{members,portal}/ + cron-broadcasts-gauges` | **51 files / 473 tests passed** |
| integration by path — `change-requests-tenant-isolation.test.ts` | **9 passed** (46.2 s, live Neon `dev`) |
| integration by path — `change-requests-decide-rollback` + `-repo` + `member-settings-prefix` | **3 files / 20 passed** |
| scoped coverage — `decide-change-request.ts`, `set-member-change-approval-enabled.ts` | **100 / 100 / 100 / 100** each |

**e2e not run in this pass** (the coordinator re-runs `US6`). No EN copy asserted by
`tests/e2e/change-requests.spec.ts` changed.

## Decisions recorded

1. **R-M5's reachability premise is refuted, with a test as the evidence** — the strict proposal
   schema at step 6 refuses an unknown stored `field_key` before `patchesOf`. The `v8 ignore`
   stays; the arm names the key anyway.
2. **R-L2 not taken** — `/admin` reads the count twice; accepted (Principle X), and the two reads
   now differ deliberately (the layout's is deadline-bounded, the page's is not).
3. **P-M2 is not a finding** — `member_change_requests.tenant_id` is the text slug (0300 line 53).
4. **No confirm-on-ON dialog** for the approval switch (P-H1) — the card description + runbook
   carry FR-040; a modal on a non-destructive configuration change is noise.
5. **SEC-5's dark path still issues the one provisioned-tenant read** — forgetting a label set
   requires knowing it, and the broadcasts tenant set is a different set. The pending scan, the
   expensive one, is what is skipped.
6. **No `Suspense` on the nav badge** — the count feeds a client component's prop through a config
   that carries functions; the read is time-boxed instead (R-H1), and the layout docblock says so.

## Seam pass — `whole-branch-reviewer` (Fable, read-only) on `321d813ee..68a3f9abe`, 2026-09-15

Verdict **MERGEABLE — no code defect at any seam**; seven docs ↔ code drift items, all closed
in the same sitting (commit after `68a3f9abe`):

- **#1 MEDIUM** — `quickstart.md` § 3 "Unflagged and live on merge" had no PR-3 entry although
  three hunks are live regardless of the flag (the `/portal/account` export-list fault alert, the
  gauges tick's new failure order + `members*` body + `tenant_member_settings` read in both flag
  states, the header-based tenant resolution on the layout/dashboard). TAKEN: a "PR-3, unflagged"
  bullet; the runbook's rollback line names PR-2 AND PR-3; step 1 says 0300–0302.
- **#2 MEDIUM** — `docs/observability.md` § 27.2 said the spans wrap the transaction "so the
  auto-instrumented Drizzle statements parent under it", contradicting § 27.5 (no database
  instrumentation is registered). TAKEN: clause removed, § 27.5 cross-referenced.
- **#3 LOW** — flag-OFF forget set is `tenant_member_settings` only, while the observe set is
  settings ∪ pending keys; a tenant with request rows and no settings row keeps its last value
  across a flip. Dead in production (a submission needs a settings row with the switch ON; PR-3
  materialises the row). TAKEN as a documented residual in § 27.1, not a code change (the only
  fix is the DISTINCT scan R-M4 just removed).
- **#4 LOW** — `research.md` § V2's "binding" decision rule still described the DISTINCT scan and
  the early return. TAKEN: a "superseded in the PR-3 review round" paragraph.
- **#5 LOW** — the flag-off contract test's positive control was a list count (`12`), not an
  on-disk walk; a route file added under an F114 tree without a flag check would not fail it.
  TAKEN: the test walks the four trees and requires `onDisk == listed` both ways.
- **#6 LOW** — `tasks.md` done-notes on T096/T099/T100/T101/T102/T103/T117/T118 described the
  pre-review shape; T116 said done with an unticked box. TAKEN: each note carries a
  "superseded by reviews/pr-3.md" suffix; T116 ticked with both halves named.
- **#7 LOW** — `cron-jobs.md`'s tick row named only the broadcasts gauges; quickstart step 1
  said "0300 and 0301". TAKEN.

Verified seams (the reviewer's list, kept for the record): setting flip → gate → form → profile
narrowing with no stale cache; the four pending-count consumers on one query with consistent
`ok | hidden | unavailable`; the gauges tick's three paths pinned by the contract test; the four
attempt buckets' keys, sizes and ordering; the settings repo's materialise-then-lock upsert under
RLS; the GET form never yields a `notFound` URL; FR-039 complete (10 route files = 10 listed,
3 pages `notFound()`, card/badge/item/scan hidden); i18n parity; RBAC agreement across route,
page and hub card. Refuted: an `X-Tenant` crash (gated by `E2E_X_TENANT_HEADER_ENABLED`);
`pendingStats` without an explicit tenant predicate (RLS-only is this repo's convention, on
`main` before PR-3); a "forged" audit on an admin flip mid-edit (`gate_narrowed` is its own
refusal); the settings GET's two reads not being one snapshot (no consumer needs one).

