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


## PR review — /pr-review-toolkit:review-pr #367 (five Opus reviewers, 2026-09-16)

`code-reviewer`, `pr-test-analyzer`, `comment-analyzer`, `silent-failure-hunter`,
`type-design-analyzer` — concurrent, read-only, on the PR-3 tree at `1f6b3dc34`
(range `321d813ee..HEAD`). Every behaviour change below was TDD'd; the RED run is quoted per
item. This round does not undo any closure from the round above.

### C1 — REFUTED before the round started: "RLS zeroes the members gauges"

One reviewer held that the gauges tick's members block reads nothing, because its cross-tenant
`GROUP BY tenant_id` runs on the pool-global `db` under RLS.

**Measured on the `dev` branch, 2026-09-16**: the pool connects as `neondb_owner`;
`current_user = neondb_owner`, `rolbypassrls = true`, and that role OWNS all three tables the
tick reads (`broadcasts`, `tenant_member_settings`, `member_change_requests`). RLS does not
apply. The cross-tenant reads are correct as written, and the B4 live test below now proves it
end-to-end: the tick counts a seeded pending row through the real schema
(`membersPendingTotal: 1`, `membersOldestAgeSecondsMax: 413017`).

Standing caveat (`reference_ops_gauge_bare_db_bypasses_rls`): this holds because of the ROLE, not
the code. A deployment whose pool connects as `chamber_app` (NOBYPASSRLS) would read 0 silently.

---

## A. Critical

### A1 — TAKEN. The withdraw banner read a 404 by a flat string, and `requireMemberContext` answers a nested one

`pending-request-banner.tsx` split the 404 on `body.error === 'no_pending_request'`: that string
meant "gone", and **everything else** meant `hidden` + `return null` + `router.refresh()`.
`requireMemberContext` (`src/lib/member-context.ts` ~108 / ~172) answers a NESTED
`{ error: { code: 'not_found' } }` when the caller's member or contact is not linked under their
user — a real data inconsistency. It took the silent arm: the banner vanished, the refresh
repainted it from the server, and the person watched their click do nothing, with nothing logged.

**Fix**: only the two codes the withdraw ROUTE itself answers are silent, and the FLAT shape is
the discriminator — the route answers flat, a guard in front of it answers nested, and the two
spell `not_found` identically while meaning opposite things. Flat `no_pending_request` → "gone";
flat `not_found` → hidden (the flag-off race, unchanged); **anything else** → `setFailed('error')`
+ `console.error` naming the status and the code. The narrowing is the B7 helper's
`readProblemCode`, which returns `{ code, shape }`.

**RED** (`tests/unit/members/presentation/pending-request-banner-withdraw.test.tsx`): 3 failed /
10 — all three new cases `Unable to find an element by: [data-testid="withdraw-error"]`.
**GREEN**: 10 passed. The nested case asserts the alert, the banner STILL PRESENT, `refresh` NOT
called and a console line carrying `404`; the unparsable-body and unknown-flat-code cases assert
the same; the two silent arms are pinned unchanged.

Files: `src/components/members/change-requests/pending-request-banner.tsx`, its unit test,
`src/lib/http/read-only-refusal.ts` (B7).

### A2 — TAKEN (comment). `(home)/page.tsx` ~372

"the read helper already answers null there" → "answers `hidden` (no query) there". The helper
stopped answering `null` in the previous round (R-H2).

---

## B. Important

### B1 — TAKEN. The attempt bucket's input was four strings and numbers

`src/lib/change-request-attempt-bucket.ts` took `{ key: string; max: number; windowSeconds: number;
errorIdPrefix: string }`. The key has a grammar (`f114:<route>-attempts:<tenant>:<user>`) and every
segment is load-bearing: one assembled by hand without the tenant segment is a GLOBAL bucket, and
the symptom is tenant B being refused because tenant A was noisy — with nothing anywhere saying
so. `max` + `windowSeconds` as two free numbers let a fifth route invent a size matching neither
the runbook nor § 27.1.

**Fix**: `attemptBucketKey(route, tenantSlug, userId)` returns a BRANDED `AttemptBucketKey` and is
the only way to mint one; `size: 'submit' | 'probe'` resolves `{ max, windowSeconds }` inside
(60/600, 10/600); `errorIdPrefix` is typed `` `M114.${string}.${string}` ``. The four route call
sites pass the route name as the KEY SEGMENT it already used (`submit`, `withdraw`,
`history-item`, `acknowledge`) so the live Redis keys are byte-identical — a tidier spelling would
have emptied every in-flight bucket.

**RED** (new `tests/unit/lib/change-request-attempt-bucket.test.ts`):
`TypeError: attemptBucketKey is not a function` — 4 failed / 5.
**GREEN**: 5 passed. The four production keys are asserted verbatim; two tenants and two users
never share a bucket; the two sizes equal the documented 60 / 10 min and 10 / 10 min. The
type-level pin is a `@ts-expect-error` on assigning a raw string to `AttemptBucketKey` — and
`pnpm typecheck` exiting 0 is what proves it, since an unused `@ts-expect-error` is TS2578.
`tests/unit/architecture/change-requests-error-id.test.ts` (15) and the 19 portal contract files
(167) stayed green — the source scan still sees `errorIdPrefix: ERROR_ID`.

### B2 — TAKEN. `badgeCount` and `badgeLabelKey` were independent optionals

`NavItem` carried both, so "a count with no noun to announce it" and "a noun with no count" were
equally representable — and `applyNavBadges` stamped a count on ANY href in its map, so an item
that never declared a badge rendered a bare number with no sr-only suffix (an accessible name
reading "Plans 3").

**Fix**: one authored field `badge?: { labelKey: string }`; `applyNavBadges` returns
`RenderedNavConfig` whose items are `RenderedNavItem = NavItem & { badgeCount?: number }` and
stamps a count ONLY on items that declare a `badge`; the map is
`NavBadgeCounts = Partial<Record<BadgeableNavHref, number>>` with
`BadgeableNavHref = '/admin/change-requests'`, so a typo'd href in the staff layout is a compile
error. `nav-item.tsx` requires both halves (second layer). The nav.ts JSDoc no longer carries the
wrong "3 pending change requests" example and points at `nav-item.tsx` for the rendered shape.

**RED** (`tests/unit/nav/nav-config.test.ts` + `tests/unit/components/layout/nav-item-badge.test.tsx`):
6 failed / 42 — `expected { '/admin/a': 3, '/admin/b': 7, …} to deeply equal { '/admin/a': 3, …}`,
`expected undefined to deeply equal { Object (labelKey) }`, and four
`Unable to find an accessible element with the role "link" and name "Change requests 3 pending"`.
**GREEN**: 72 passed across `tests/unit/nav/` + `tests/unit/components/layout/`. New cases: an
href in the map whose item declares no badge is ignored; an item without a declaration renders no
badge even when a count rides along; the staff config authors no `badgeCount` and
`/admin/change-requests` is the ONLY badgeable item (so the type and the config agree).

Files: `src/config/nav.ts`, `src/components/layout/nav-item.tsx`,
`src/components/layout/staff-sidebar.tsx`, the two unit tests.

### B3 — TAKEN. The setting outcome allowed a transition with no instant, and an instant with no transition

`SetMemberChangeApprovalEnabledOutcome` was `{ changed: boolean; changedAt: Date | null }` — two
independent fields for one fact. The audit branch IS the `changed: true` branch.

**Fix**: a union discriminated on `changed`; `changedAt: Date` exists only on the `true` arm. The
WIRE shape is unchanged (`changedAt: null` on the no-op — the card branches on it to decide
whether to toast, R-L5); the route mints that null at the boundary.

**RED** (`tests/unit/members/change-requests/set-member-change-approval-enabled.test.ts`): 2 failed
/ 10 — `expected { ok: true, value: { …(4) } } to deeply equal { ok: true, value: { …(3) } }`.
**GREEN**: 10 + the 14 contract cases in `admin-member-changes-setting.test.ts` = 24 passed. The
no-op case now asserts `'changedAt' in value` is FALSE; the transition case narrows on `changed`
before reading `changedAt`.

### B4 — TAKEN. The gauges tick's members half had no live coverage

`tests/integration/broadcasts/broadcasts-gauges-cron.test.ts` is the API-route gate file for
`broadcasts-gauges/route.ts`, and it exists precisely because a wrong column would fail every five
minutes with every static gate green. T102 added two statements to it with no live assertion.

**Fix**: the file seeds a plan → member → primary contact → portal user and one PENDING change
request (the `change-requests-repo.test.ts` recipe, `submittedAt` in the past), drives `GET`, and
asserts `membersGaugesOk === true`, `membersGaugesSkipped === null`,
`membersPendingTenantCount >= 1`, `membersPendingTotal >= 1`, `membersOldestAgeSecondsMax > 0`.
Floors, not equalities — other tenants live on `dev` — but zero would mean the scan found nothing.
The seed's `ok` is asserted so a silent seed failure cannot make the assertions vacuous.

**GREEN** (live Neon `dev`, by path): 3 passed, 29.5 s. The tick logged
`membersGaugesOk: true, membersPendingTenantCount: 1, membersPendingTotal: 1,
membersOldestAgeSecondsMax: 413017`.

### B5 — TAKEN (live half); the FAKE half was already correct, and that is measured

The live assertion at `change-requests-repo.test.ts` ran against a tenant holding nothing but
pending rows, so it held whether or not the SQL filtered at all.

**Fix (live)**: two NON-pending rows are seeded into tenant A first — both submitted
2026-09-01, i.e. EARLIER than the pending row — by withdrawing one and deciding the other. They
are submitted by tenant B's user under tenant A, because the partial unique index is per
(tenant, submitter) and that is the only way to hold a second request in this tenant. Both are
deleted in a `finally` (they hang off tenant A's member and four later assertions in the file
count its rows).

**Mutation-proven**: removing `.where(eq(memberChangeRequests.state, 'pending'))` from
`drizzleChangeRequestRepo.pendingStats` fails the case — `expected 3 to be 1` — and the repo was
restored byte-identical (`git diff --stat` empty). **GREEN**: 15 passed, 45.3 s.

**The fake half needed no change, and that is measured too.**
`tests/helpers/change-request-fakes.ts` `pendingStats` already computes over ALL rows and filters
`state === 'pending'` inside, the way the SQL does; and
`tests/unit/members/change-requests/count-pending-change-requests.test.ts` already seeds a decided
and a withdrawn row alongside two pending ones. Removing the filter from the fake fails that case
— `expected { count: 4 } to deeply equal { count: 2 }` — so the unit case measures the projection,
not the fake. Restored byte-identical. Recorded rather than "fixed".

### B6 — TAKEN. The e2e US6 assertions could not fail on the numbers

(a) The audit test depended on the test ABOVE it having flipped the setting (`--workers=1` fixes
the order; a skip, a retry or a reorder does not) and asserted `toContainText` on the whole table
— which the FILTER CHIP echoing the event type satisfies on an EMPTY result. It now makes its own
transition as the ADMIN persona (`page.request.patch('/api/admin/settings/member-changes')` with
the Origin header, off then on so a transition exists whatever state the tenant was in), clears
cookies, signs in as super_admin, and asserts `getByRole('row')` count ≥ 2 (header + one) with
row 1 containing the setting label.

(b) The first test asserted `toBeVisible()` on a `/^Change requests \d+ pending$/` badge, which
passes on any number including a stale one. It now pins the SEEDED count (`beforeAll` wipes this
persona and seeds exactly one): the dashboard row's count, the nav badge's number and the queue's
`queue-row` count are all read and must all equal 1, and the seeded row must be present in the
queue. The dashboard count is read from the row's digits-only node, not from the link — the link's
own text contains "oldest 1 day", so asserting the count on it would have passed vacuously.

Not run here (the coordinator runs US6 + US4). Selectors stay by accessible name.

### B7 — TAKEN. A 200 the card could not read became "Approval is off"

`approval-switch.tsx` did `const value = body.approvalEnabled === true`, so a 200 whose body
carries no boolean — a truncated body, a reshaped envelope, a proxy's HTML page — coerced to
`false` and the card announced "Approval is off" about a tenant the server had just switched ON.
The state line then disagreed with both the stored value and the audit row.

**Fix**: a `readApproval(body: unknown)` narrowing; a body without a boolean `approvalEnabled` is
`t('errors.generic')` and NO state change.

**RED**: 3 failed / 15 — `Unable to find an element by: [role="alert"]`, with the rendered DOM
showing "Approval is off — new member changes apply immediately."
**GREEN**: 15 passed. Three shapes (no key, a non-boolean, an unparsable body) all alert; a 200
carrying `approvalEnabled: false` is pinned as a REAL answer, so the guard cannot widen into
"never trust a false".

**The extraction**: the six verbatim copies of the read-only 503 check (`approval-switch.tsx`,
`plans-table.tsx`, `invoice-settings-form.tsx`, `clone-year-client.tsx`, `new-plan-client.tsx`,
`edit-plan-client.tsx`) now compose `src/lib/http/read-only-refusal.ts`. Each copy had to get
both envelopes AND both spellings right, and a seventh caller getting one wrong shows the operator
"save failed, try again" during a write freeze.

**Byte-identical behaviour, deliberately in two pieces.** `isReadOnlyRefusal(status, body)`
requires the 503 and is used by `approval-switch.tsx`, which already checked it. The other five
branch on the code ALONE (they also handle `not_found`, `plan_has_active_members`,
`idempotency_conflict`, …) and never looked at the status — so they compose
`problemCode(body) ?? 'generic'` with `isReadOnlyCode(code)`, and the helper does not silently add
a status condition to a ladder that never had one. A1 needs the SHAPE as well as the code, so
`readProblemCode` returns `{ code, shape: 'flat' | 'nested' }` and `problemCode` is the
shape-blind reading of it.

New `tests/unit/lib/http/read-only-refusal.test.ts` (10): both envelopes, both spellings, every
non-body (`null`, a string, an array, a number, `{ error: {} }`, `{ error: { code: 7 } }`) → null,
the flat/nested split, and `isReadOnlyRefusal`'s status condition in both directions. The five
callers' existing tests are unchanged and green (`clone-year-client` 5,
`invoice-settings-save-affordances` 10, `plans-table-affordances` 5, `tests/contract/plans/` in
the 62-file contract run).

### B8 — TAKEN. The dashboard's `allSettled` rejected arm left no trace

`(home)/page.tsx` mapped a rejection to `unavailable` — the right SURFACE — with no log at all,
while every other arm in the file logs its own rejection. It is also the one arm nobody can
reproduce, since the helper swallows both of its own channels: it fires only on a throw ABOVE the
helper's try (env / RBAC / the deps composition root).

**Fix**: `logger.error({ errorId: 'M114.dashboard.pending_count_failed', tenantId, err: errKind(reason) })`.

**RED** (`tests/unit/app/admin/dashboard/needs-attention-change-requests.test.tsx`, a new case
making `buildChangeRequestDeps` throw): 1 failed / 10 —
`the rejected arm logs under the dashboard errorId: expected undefined to be defined`.
**GREEN**: 29 passed across `tests/unit/app/admin/dashboard/`. The case also pins `err: 'TypeError'`
— `errKind`, never the raw error.

### B9 — TAKEN. A members-half fault answered 200, and latched both series

(a) The tick answered **200** when only the members half failed, with the bad news in
`membersGaugesOk: false` inside the body — so the one thing every cron monitor checks said the
tick was healthy while the FR-037 age gauge, the 30-day data-subject-request backstop, was stale.
It now answers **500** with `error: 'query_failed'` when EITHER half failed; the per-half flags and
both log names are unchanged, so the alert rules that name a half keep working.

(b) Emitting nothing on a fault is not neutral: `observeGauge` re-reports the last value at every
scrape, so a sustained outage froze the queue depth and the age — "3 pending, oldest 13 d" forever,
never crossing 14 d, indistinguishable from a quiet week. The members catch now FORGETS both
labels for every tenant in `lastMembersTenantSet`, a module-level set updated on every successful
tick. Documented as PER SERVERLESS PROCESS: a cold instance has emitted nothing and has nothing to
forget, and the next healthy tick re-observes the real set. Best-effort de-latch, not a durable
record.

**RED** (`tests/contract/broadcasts/cron-broadcasts-gauges.contract.test.ts`): 2 failed / 21 —
`expected 200 to be 500` on both new cases.
**GREEN**: 21 passed. The de-latch case runs a healthy tick, asserts nothing was forgotten, then a
faulting tick and asserts `forgetGauges` for exactly `['other', 'swecham']` with neither gauge
re-stated (a 0 would assert "the queue is empty", a different fact).

**A finding inside the finding**: seven broadcasts-only cases in that file mocked only the FIRST
`db.transaction` and said nothing about the second, so the members half was throwing on
`undefined` in each of them — invisible while only the broadcasts flag decided the status. A
default `dbTransactionMock.mockImplementation` answering a quiet members half was added in
`beforeEach`, and each case opts in to more.

Docs: `docs/observability.md` § 27.1 (the status rule + the forget-on-fault paragraph) and § 27.3
(the members row now says HTTP 500 and "absent, by design"), plus the runbook's Alarm 4.

### B10 — TAKEN. `SpanStatusCode.ERROR` on every refusal made the error rate a typo counter

Both span wrappers set ERROR with the error TYPE as the message for EVERY `!result.ok`. Most of
those arms are the product working as specified — `member_archived`, `rate_limited`, `not_found`,
`already_decided`, `validation_error` — so the two F114 spans' error rate measured how often a
member mistypes a phone number, burying the one signal an operator can act on.

**Fix**: ERROR only for `server_error`; every expected refusal sets
`change_request.refusal = <type>` and leaves the status UNSET, so the reason is still sliceable.
A `catch` was added before the `finally { span.end() }` in both, marking the span with the error's
CONSTRUCTOR NAME and re-throwing — `recordException({ name })`, never `.message`, which can carry
a proposed value or the reviewer's reason. It mirrors `confirm-payment.ts` exactly, `v8 ignore`d
for the same reason: both use cases convert every fault to a `Result` inside their own transaction
body, so nothing reaches it. Recorded as defence-in-depth rather than pretended to be tested.

**RED** (`tests/unit/members/change-requests/change-request-spans.test.ts`): 2 failed / 8 —
`expected [ { code: 2, message: 'not_found' } ] to deeply equal []`.
**GREEN**: 8 passed. Two NEW non-mutant cases pin that a `server_error` IS the ERROR arm on both
spans and carries NO `change_request.refusal` (never both); the `SECRET-REASON` redaction assertion
holds on the refusal arms, the server_error arms, and a throw whose MESSAGE is the reviewer's
reason (status ERROR `server_error`, no recorded exception, span ended once, "SECRET" nowhere in
the serialised span).

Docs: § 27.2 rewritten (the status rule, the refusal attribute, the constructor-name rule).

### B11 — TAKEN (comments / docs), five one-liners

| Where | Change |
|---|---|
| `tests/contract/portal/change-requests-flag-off.test.ts:6-7` | "the eleven handlers" → "the twelve handlers" (the file's own positive control says `toHaveLength(12)`) |
| `approval-switch.tsx:10` | the `nativeButton=false` clause dropped — Base UI puts the caller `id` on its hidden `<input type=checkbox>` (`useLabelableId`) regardless |
| `docs/observability.md` § 27.2, submit row | `change_request.id` is "a freshly minted request id — the id the insert WOULD carry; on the coalesce / no-op / refused arms no row carries it" |
| `docs/observability.md` § 27.5 | "registers no instrumentations beyond `registerOTel({ serviceName })` — the file's only other call is a boot-time env assertion (`assertVercelDeploymentForTrustedXff`)" (verified against `instrumentation.ts`) |
| `research.md` § V2 | "Measured 2026-09-15" → "As measured BEFORE PR-3 … the route is now TWO transactions with a flag per half — see the supersession below" |

### B12 — TAKEN. The dotted gauge names do not exist

The emitters are underscored (`src/lib/metrics.ts` 6093 / 6111):
`members_change_requests_pending_count`, `members_change_request_oldest_age_seconds`. The dotted
spelling appeared in six documents — an operator pasting one into a metrics query gets no data and
no error. Swept in `docs/runbooks/cron-jobs.md` (2), `research.md` (2), `tasks.md` (4),
`quickstart.md` (1) and `CLAUDE.md` (3). `docs/changelog.md` and
`docs/runbooks/member-change-requests.md` were already correct (grepped).
`.specify/bridge-snapshots/**` is frozen bridge state and was left alone.

### B13 — NOT TAKEN (the settings PATCH bucket) / TAKEN-as-composition (the layout test)

**The settings PATCH attempt bucket: not taken.** No staff route in this repo carries one — the
`permission_denied` audit row on a refused staff call is the house pattern, and a bucket there
would be the first of 119 routes. The four F114 buckets exist because their routes are
MEMBER-facing and one of them writes an append-only probe row per miss; neither applies to a
`members.write` PATCH behind the staff RBAC gate.

**The layout RSC test: taken as a composition test.** An RSC test of `layout.tsx` would be a test
of `requireSession` + `cookies()` + `<StaffSidebar>`, none of which is the property in question.
The property is: whichever of the three kinds the read answers, what `badgeCount` reaches the
rendered nav? One case in `tests/unit/lib/pending-change-requests.test.ts` pipes all three through
the layout's own expression (`kind === 'ok' ? summary.count : 0`) into the REAL `applyNavBadges`
over the REAL `staffNavConfig`: `ok` at 7 badges 7; `ok` at 0, `hidden` and `unavailable` all
render no badge. **Mutation-proven**: `count > 0` → `count >= 0` in `applyNavBadges` fails it
(`expected +0 to be undefined`); restored.

---

## C. Suggestions

### C1 — TAKEN. `hidden` now says WHICH gate answered

`{ kind: 'hidden' }` → `{ kind: 'hidden'; reason: 'flag_off' | 'not_permitted' }`. One surface, two
facts: the first is every viewer (FR-039), the second is this viewer alone (FR-026) and goes away
with a role change. Collapsed, a manager's own blank badge reads as evidence the flag is off
during a cutover check.

**RED** (`tests/unit/lib/pending-change-requests.test.ts`): 4 failed / 10 —
`expected { kind: 'hidden' } to deeply equal { kind: 'hidden', reason: 'flag_off' }`.
**GREEN**: 11 passed (10 + the B13 composition case). A new case pins that the two reasons are
distinguishable AND that the FLAG gate answers first, for a role the permission gate would also
have refused.

### C2 — TAKEN. `[] as MembersPendingRow[]` and the `as ResponseBody` cast

The route's empty-rows literal keeps its annotation as the typed empty the flag-off arm returns
(it is the arm's value, not a cast of a wider one); `approval-switch.tsx`'s
`(await res.json()) as ResponseBody` is now `unknown` narrowed by `readApproval` / the B7 helper,
so a missing field can no longer look like a present one.

### C3 — TAKEN. `isoOrNull(r.submittedAt) ?? ''`

`member_change_requests.submitted_at` is NOT NULL (migration 0300) and `ChangeRequest.submittedAt`
is a `Date`, so the nullable reader plus an empty-string fallback said a row could arrive without a
submission time and the archive would ship `"submittedAt": ""` rather than fail. Now
`r.submittedAt.toISOString()`; the exact-JSON test is byte-identical.

### C4 — TAKEN. The R-M5 proof now names the layer that refused

`decide-change-request.test.ts` asserted only that the issue list was non-empty and mentioned
`legacy_fax` — which would still pass if the refusal MOVED to `patchesOf`, and the `v8 ignore`
proof would quietly stop proving anything. It now asserts `issues[0].code === 'unrecognized_keys'`,
zod's strict-object refusal, i.e. `validateProposal` at step 6.

### C5 — TAKEN. `?? false` could only fabricate a `previous`

`drizzle-tenant-member-change-settings-repo.ts`: after the materialising
`INSERT … ON CONFLICT DO NOTHING`, the locked read always has a row — the insert either created one
or waited for the writer that did. `?? false` therefore could not be a default; it could only
supply a fabricated `previous` for an audit row stating a transition that never happened, which is
the invariant this repo exists to hold. It now returns `err(unexpected(...))`.

Defensive and unreachable, so no test reaches it; the reachable path is unchanged and
**GREEN** on live Neon by path: `change-requests-tenant-isolation.test.ts` 9 passed, 52.2 s,
including the two overlapping-transaction cases and the Constitution I.3 cross-tenant case.

### C6 — TAKEN. `errKind:` → `err:`

`portal/account/page.tsx` ~262, the F114 exports-read log — the house field name for an error kind.
The four older `errKind:` lines in that file predate F114 and were left alone (out of this PR's
scope). Its test assertion moved with it.

### C7 — NOT TAKEN, recorded

1. **The summary union** `{ count: 0; oldestAgeSeconds: null } | { count > 0; number }` — all three
   consumers already branch on `null`, and the type cannot express "> 0" without a brand and a
   constructor. Principle X.
2. **The 429 copy in the two banners** — acknowledge's bucket is 10 / 10 min, reachable only by
   dismissing ten outcomes in ten minutes. Follow-up, not this PR.
3. **A `fellBack` dimension on the refused metric** — the limiter logs and meters its own fallback;
   a second dimension on a counter that already carries `reason` would double-count the same
   outage.
4. **`forgetGauges` throwing / an empty tenant set in the gauges tick** — `forgetGauges` is a
   `safeMetric` wrapper over two `Map.delete` calls, and an empty set is the cold-process state
   B9 documents.
5. **A timer-cleared assertion on the nav read's fast path** — `clearTimeout` is in a `finally`;
   asserting it would test `finally`.

---

## Gates at this tree (foreground, 2026-09-16)

| Gate | Result |
|---|---|
| `pnpm typecheck` | exit 0 (no tsc output) |
| `pnpm lint` (full) | exit 0 |
| `pnpm check:i18n` | OK — 5,531 keys in all 3 locales |
| `pnpm check:layout` | OK — 136 page/loading files, pairs consistent |
| `pnpm check:audit-events` | OK — F5 count 20; F9 enum ↔ taxonomy 16 match |
| `pnpm check:strict-aria` | OK — 0 hardcoded aria-text attributes across 632 TSX files |
| `vitest run tests/unit/{members,lib,app,nav,components,architecture,insights}/` | **514 files / 5,093 tests passed** |
| `vitest run tests/contract/{members,portal,plans}/ + cron-broadcasts-gauges` | **62 files / 574 tests passed** |
| integration by path — `broadcasts-gauges-cron.test.ts` | **3 passed** (29.5 s, live Neon `dev`) |
| integration by path — `change-requests-repo.test.ts` | **15 passed** (45.3 s) |
| integration by path — `change-requests-tenant-isolation.test.ts` | **9 passed** (52.2 s) |
| scoped coverage — the six pinned use cases | **100 / 100 / 100 / 100** (229 files / 2,130 tests) |

**e2e not run in this pass** — the coordinator runs US6 + US4.

## Decisions recorded

1. **The "RLS zeroes the gauges" premise is refuted, with the role facts measured** — the pool is
   `neondb_owner`, `rolbypassrls = true`, owner of all three tables. B4 now proves the read
   end-to-end against live Neon.
2. **`isReadOnlyRefusal` requires the 503; the five ladder callers compose `problemCode` +
   `isReadOnlyCode` instead** — the extraction must not silently add a status condition to five
   ladders that never had one. Byte-identical behaviour was the constraint, not tidiness.
3. **The A1 discriminator is the ENVELOPE SHAPE, not the code** — our routes answer flat, a guard
   in front of them answers nested, and both spell `not_found`. `readProblemCode` returns the
   shape so the banner can tell "the route answered my own 404" from "a guard answered a different
   one".
4. **The four bucket route names are the KEY SEGMENTS, hyphen included (`history-item`)** — they
   are live Redis keys; a tidier spelling would empty every in-flight bucket.
5. **The span catch is `v8 ignore`d defence-in-depth, mirroring `confirm-payment.ts`** — both
   transaction bodies convert every fault to a `Result`, so it is unreachable to a test. Recorded
   rather than covered by a test that would only exercise the mock.
6. **`lastMembersTenantSet` is per serverless process and documented as such** — a durable record
   would need a store; the de-latch is best-effort and the next healthy tick re-observes the real
   set.
7. **B5's fake half was already correct** — mutation-proven, and recorded as a refutation rather
   than changed.
8. **The settings PATCH carries no attempt bucket (B13)** — no staff route in this repo does; the
   `permission_denied` audit row is the house pattern.
