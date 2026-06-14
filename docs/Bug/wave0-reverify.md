COUNTS: {"total": 19, "stillPresent": 8, "alreadyFixed": 6, "refuted": 5}
======================================================================
STILL_PRESENT (8):
  W0-02 [data-integrity/M] cheapWin=False  src/modules/plans/application/soft-delete-plan.ts:87-123
     fix: Wrap the count + softDelete in one tenant transaction guarded by `pg_advisory_xact_lock(hashtextextended('plans:softdelete:'||tenant||':'||planId||':'||year,0))`, and take the same lock in change-plan's member-assignment write path.
     evid: soft-delete-plan.ts:90 `memberCount = await deps.members.countActivePlanMembers(...)` and :109 `updated = await deps.planRepo.softDelete(...)` are separate calls. count-active-members-on-plan.ts:49 `await runInTenant(ctx, (tx) => ...)` and 
  W0-08 [security/S] cheapWin=True  src/app/api/payments/initiate/route.ts:131
     fix: In initiate/route.ts and [id]/cancel/route.ts, import { errKind } from '@/lib/log-id' and replace each `err: e instanceof Error ? e.message : String(e)` with `errKind: errKind(e)` (6 sites), mirroring the already-fixed refunds/initiate route.
     evid: initiate/route.ts:131 `{ err: e instanceof Error ? e.message : String(e), requestId, correlationId }, 'payments.initiate.member_context_throw'` — plus initiate:194,332 and [id]/cancel/route.ts:82,136,216 all still log `err: e instanceof Err
  W0-09 [observability/L] cheapWin=False  src/lib/metrics.ts:1673
     fix: Wire the missing OTel counters/gauges: add a coordinator counter pair + cron_bearer_auth_rejected counter in cron-auth.ts 401 path, recompute_members_{succeeded,failed} in compute-at-risk-score, and a pipeline row_count gauge — or trim §23.1/F8-A1/F8-A3 to the audit-only signals that actually exist.
     evid: §23.1 catalogue (docs/observability.md L1117/L1146-1147/L1175-1180) lists `renewals.pipeline.row_count`, `renewals.at_risk.recompute_members_{succeeded,failed}_total`, `renewals.coordinator.tenants_{enqueued,succeeded,failed}_total`, `renew
  W0-11 [security/M] cheapWin=False  src/modules/auth/application/disable-user.ts:74
     fix: Add UserRepo.findByIdInTenant(tenantId, id) (or scope via runInTenant) and have disableUser/changeRole return 'not-found' (→404) when the target is outside the actor's tenant — a F10 multi-tenant pre-condition.
     evid: disable-user.ts:74 `const target = await deps.users.findById(input.targetUserId);` and change-role.ts:63 same call. user-repo.ts:205-209 `findById`: `const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);` — global tab
  W0-13 [security/S] cheapWin=True  src/modules/events/infrastructure/drizzle-attendee-matcher.ts:51,227
     fix: Delete the `export const drizzleAttendeeMatcher` singleton (line 266) and the `= db` default on the `executor` param, forcing every caller to pass a tx-bound executor.
     evid: Line 64-66: `export function makeDrizzleAttendeeMatcher(executor: TenantTx | typeof db = db,): AttendeeMatcher {` — still defaults to root `db`. Line 266: `export const drizzleAttendeeMatcher: AttendeeMatcher = makeDrizzleAttendeeMatcher();
  W0-15 [security/S] cheapWin=True  src/app/api/broadcasts/[id]/route.ts:87
     fix: Replace line 87 with `customRecipientCount: broadcast.customRecipientEmails?.length ?? null,` so the GET body returns a count instead of the raw email list.
     evid: src/app/api/broadcasts/[id]/route.ts:87 inside the GET NextResponse.json body: `customRecipientEmails: broadcast.customRecipientEmails,`. The field is the full PII email list — domain type is `readonly customRecipientEmails: ReadonlyArray<s
  W0-17 [security/M] cheapWin=False  src/app/api/portal/renewal/[memberId]/confirm/route.ts:15-17
     fix: After requireMemberContext, add rateLimiter.check(`renewal-confirm:${ctx.tenant.slug}:${ctx.memberId}`, 10, '1h') and return 429 via errorResponse on limit.
     evid: Lines 15-17: "Rate-limit: 10/1h per member per FR-027 (deferred — wired alongside existing rate-limit infra in a follow-on; the portal page rate-limits the verify-token path which is the actual abuse vector)." The POST handler (lines 42-232
  W0-18 [security/M] cheapWin=False  src/app/api/portal/account/data-export/route.ts:24-107
     fix: Add `await rateLimiter.check('gdpr-export-request:'+tenant.slug+':'+actorId, 3, 3600)` returning 429+Retry-After to BOTH the portal and admin-on-behalf POST handlers.
     evid: route.ts POST (lines 24-107) has no rateLimiter import/call — only delegation to requestDataExport; that use-case bounds dupes solely via per-UTC-minute key: minuteBucket() returns `now.toISOString().slice(0, 16)` (request-data-export.ts:70
----------------------------------------------------------------------
ALREADY_FIXED (6):
  W0-01 src/modules/auth/application/forgot-password.ts:161-165
     forgot-password.ts:170-173 now wraps both calls in one tx: `const { plaintext, token } = await db.transaction(async (tx) => { await deps.tokens.invalidateAllUnconsumedForUserInTx(tx, user.id, now); re
  W0-04 src/modules/insights/infrastructure/repos/drizzle-export-job-repo.ts:225-238
     setDownloadTokenInTx WHERE now includes the expiry predicate the finding asked for: line 240 `or(isNull(exportJobs.expiresAt), gt(exportJobs.expiresAt, new Date())),` alongside the status guard `inArr
  W0-05 src/modules/insights/infrastructure/sources/gdpr-archive-source-adapter.ts:270-305
     The two trivially-addable omissions the finding cites are now present in the projection. Line 278: `turnoverThb: member.turnoverThb,` (with comment "P2 Wave-0 — the member's own annual turnover is sub
  W0-07 src/modules/invoicing/application/use-cases/export-paid-invoices-csv.ts:143-149
     Lines 144-154: `} catch (e) { ... logger.error({ tenantId: input.tenantId, err: e instanceof Error ? e.message : String(e) }, 'exportPaidInvoicesCsv: paid-invoice scan failed'); return err({ code: 'li
  W0-12 src/modules/invoicing/application/use-cases/resend-pdf.ts:249,265,342
     All three summary strings no longer interpolate ${recipientEmail}. Line 250: `summary: `Invoice ${documentNumber} PDF resent (recipient hashed in payload)`,` (invoice_pdf_resent). Line 266: `summary: 
  W0-14 src/lib/logger.ts:537-542
     src/lib/logger.ts:88-93 now contains the fix: "// P2 Wave-0 — F6 attendee-import logs the lower-cased attendee email as / `attendeeEmailLower` (a distinct key the `email`/`*.email` paths do NOT / matc
----------------------------------------------------------------------
REFUTED (5):
  W0-03 src/modules/members/application/use-cases/member-self-update.ts:194
     Inside runInTenant (member-self-update.ts) the tx now does both things the finding claims are missing: line 300 `const fresh = await deps.memberRepo.findByIdInTx(tx, input.memberId);` and line 302 `if
  W0-06 src/app/api/cron/insights/process-export-jobs/route.ts:74-107
     route.ts:119-124 now runs a "Retention purge" step: `purged = await runInTenant(tenant, (tx) => repo.purgeRetiredInTx(tx, new Date(startedAt - RETENTION_GRACE_MS)));` (RETENTION_GRACE_MS = 30 days). T
  W0-10 src/app/api/plans/search/route.ts:275
     search-plans.ts:66-71 defines the union code-only: `export type SearchPlansError = | { readonly type: 'server_error'; readonly errKind: string };` (no `message` field). The catch (search-plans.ts:368-
  W0-16 src/app/api/broadcasts/[id]/route.ts:84
     The raw-write/raw-return lines exist (submit-broadcast.ts:588 `bodySource: input.bodySource,` + :618 same in updateDraft, vs :587/:617 `bodyHtml: sanitised.value.sanitisedHtml`; route.ts:84 `bodySourc
  W0-19 .env.example:273
     .env.example now has a full F5 section (lines 275-288): `# --- F5 Online Payment (Stripe + PromptPay) ---` followed by `STRIPE_SECRET_KEY="sk_test_xxxxxxxxxxxxxxxxxxxxxxxx"`, `NEXT_PUBLIC_STRIPE_PUBLI
======================================================================
FIX PLAN:
All findings confirmed against live code. The `errKind` helper exists and is already imported in the data-export route; the renewal route even has a code comment admitting the rate-limit was deferred. Here is the prioritised plan.

---

# Wave-0 Fix Plan — 9 STILL_PRESENT findings

## BATCH 1 — Cheap wins, ship in one commit now (effort S, low-regression)

These are 4 small, surgical, security/leak fixes with near-zero blast radius. Do them together, run `pnpm lint && pnpm typecheck` + the touched modules' contract tests, one commit.

| ID | File | Change | Why safe |
|----|------|--------|----------|
| **W0-15** | `src/app/api/broadcasts/[id]/route.ts:87` | Replace `customRecipientEmails: broadcast.customRecipientEmails,` with `customRecipientCount: broadcast.customRecipientEmails?.length ?? null,` | Stops raw recipient PII (email list) leaking in GET body; pure response-shape change. **Check contract test + any UI consumer** that reads `customRecipientEmails` from this GET — grep before committing so you don't break the editor pre-fill. |
| **W0-08** | `src/app/api/payments/initiate/route.ts` + `[id]/cancel/route.ts` (6 sites) | Swap `err: e instanceof Error ? e.message : String(e)` → `errKind: errKind(e)` (import from `@/lib/log-id`) | Log-hygiene only (stops raw error strings reaching logs). Helper exists and is already the pattern in refunds/initiate + data-export. No behavior change. |
| **W0-13** | `src/modules/events/infrastructure/drizzle-attendee-matcher.ts:51,227,266` | Delete the `export const drizzleAttendeeMatcher` singleton + the `= db` default on `executor` | Forces every caller to pass a tx-bound executor (closes the silent-RLS-bypass class from the Gotchas note). **Must update all callers in the same commit** — removing the default is a compile error at every call site, which is the point; typecheck will enumerate them for you. |

W0-13 is "cheap" in effort but touches the tenant-isolation path — verify each caller now threads the `runInTenant` `tx`, not `db`. The compiler enforces the mechanical part; you verify the *right* executor is passed.

---

## BATCH 2 — Two small rate-limiters (effort S, but member-facing money/PII paths → do carefully, own commit)

Both are S-effort but sit on sensitive flows, so keep them out of Batch 1 and test the 429 path explicitly.

- **W0-18** — `src/app/api/portal/account/data-export/route.ts` (+ admin-on-behalf POST). Add `rateLimiter.check('gdpr-export-request:'+tenant.slug+':'+actorId, 3, 3600)` → 429 + `Retry-After` to **both** handlers. GDPR-export abuse = resource/DoS + PII-archive spam vector. Note the admin-on-behalf path uses a *different* actor/tenant resolution than the self-service path — key each correctly.
- **W0-17** — `src/app/api/portal/renewal/[memberId]/confirm/route.ts`. After `requireMemberContext`, add `rateLimiter.check('renewal-confirm:'+ctx.tenant.slug+':'+ctx.memberId, 10, '1h')` → 429 via `errorResponse`. **Risk flag: this route composes F4 invoice issuance (createInvoiceDraft + issueInvoice).** The limiter must run *before* any invoice work, and the limiter itself must not throw into the invoice path. Update the stale code comment at lines 15-17 that says rate-limit is deferred.

> Watch: if `rate-limit.test.ts`-style suites fail with `UpstashError: max requests limit`, that's quota exhaustion, not your code (per MEMORY).

---

## BATCH 3 — Bigger items, separate PRs each (effort M/L)

- **W0-02** [data-integrity · M] `soft-delete-plan.ts:87-123` — **Risk: money/assignment integrity.** Current code does count-then-softDelete as two separate repo calls with no shared tx/lock (confirmed: lines 88-100 count, 108-121 softDelete, no transaction around them). Wrap both in one tenant transaction guarded by `pg_advisory_xact_lock(hashtextextended('plans:softdelete:'||tenant||':'||planId||':'||year,0))`, and take the **same lock** in change-plan's member-assignment write path or the TOCTOU stays open. Needs a live-Neon integration test proving the race (concurrent assign vs soft-delete) is closed — unit mocks will hide it. Reuse the F4/F5 advisory-lock namespace discipline (`plans:` disjoint from `invoicing:`/`payments:`/`broadcasts:`).

- **W0-11** [security · M] `disable-user.ts:74` — **Risk: auth/RBAC path, F10 multi-tenant pre-condition.** Add `UserRepo.findByIdInTenant(tenantId, id)` (or scope via `runInTenant`); `disableUser`/`changeRole` must return `'not-found'` (→404, no oracle) when target is outside the actor's tenant. Touches the user-state machine and the audit chain — needs a cross-tenant integration test (Constitution Principle I mandatory blocker) and re-check that existing 404/403 contract tests still pass.

- **W0-09** [observability · L] `metrics.ts:1673` — Largest, lowest-risk-to-money. Either wire the missing OTel signals (coordinator counter pair + `cron_bearer_auth_rejected` in cron-auth 401 path + `recompute_members_{succeeded,failed}` in compute-at-risk-score + pipeline `row_count` gauge) **or** trim the §23.1/F8-A1/F8-A3 doc claims down to the audit-only signals that actually exist. Decide scope first (wire vs trim) — don't half-do it. No money/auth/PII regression risk; safe to defer last.

---

## Suggested sequencing
1. **Batch 1** (one commit, today) — 3 leak/hygiene fixes, compiler-guided.
2. **Batch 2** (one commit) — 2 rate-limiters, with explicit 429 tests.
3. **Batch 3** — three independent PRs: W0-11 (auth) and W0-02 (integrity) each need a tenant-isolation/race integration test and ≥2-reviewer security gate; W0-09 last, scope-decided.

**Carefully-flagged (could regress money/auth/PII):** W0-02 (assignment integrity TOCTOU), W0-11 (RBAC/tenant scoping), W0-17 (sits on F4 invoice issuance), W0-18 (GDPR PII archive). W0-13 is mechanically cheap but lives on the RLS-isolation path — verify executors, don't just satisfy the compiler.

**Relevant files:**
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\app\api\broadcasts\[id]\route.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\app\api\payments\initiate\route.ts` + `...\payments\[id]\cancel\route.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\events\infrastructure\drizzle-attendee-matcher.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\app\api\portal\account\data-export\route.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\app\api\portal\renewal\[memberId]\confirm\route.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\plans\application\soft-delete-plan.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\auth\application\disable-user.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\lib\metrics.ts`
- Helper: `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\lib\log-id.ts` (`errKind` confirmed present)