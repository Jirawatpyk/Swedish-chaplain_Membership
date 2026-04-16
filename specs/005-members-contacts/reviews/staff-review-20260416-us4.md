# Staff-Engineer Review — F3 US4 (Inline Edit + Bulk Actions)

**Branch**: `005-members-contacts`
**Date**: 2026-04-16
**Scope**: 5 commits — `12885d8` → `a17c8a1` → `1744452` → `709b866` → `e6dee21`
**Reviewer**: Claude Opus 4.6 (staff-level review)
**Review rounds prior**: 4 (C1-C7 + R2/R3/R4 fixes)

---

## Executive Summary

**Verdict: ❌ CHANGES REQUIRED**

US4 has received four rounds of review and is near production quality, but a staff-level re-read
surfaces **one critical TOCTOU blocker** in `bulk-action` that was already fixed in `inline-edit`
during round 3 — the same pattern was not propagated to `bulk-action`.

- 1 🔴 Blocker (integrity / audit trail / Principle I)
- 6 🟡 Warnings (perf, spec non-compliance, correctness edges)
- 5 🟢 Suggestions

Test suite is comprehensive (bulk: 6 contract + 4 cap + 3 rate-limit + 5 branches + 5 live-Neon
status-tx; inline: 9 contract + 13 integration + 11 presentation) but lacks a TOCTOU regression
test that would have caught the blocker.

---

## Findings

| ID | Severity | File | Line(s) | Description |
|---|---|---|---|---|
| **SB-1** | 🔴 Blocker | `src/modules/members/application/use-cases/bulk-action.ts` | 169-172 | `findById` (not `findByIdInTx`) used inside `runInTenant` → TOCTOU lost-update + stale `old_plan_id` in audit payload. Same bug inline-edit fixed in round 3 (N-C1). |
| **SW-1** | 🟡 Warning | `src/modules/members/application/use-cases/bulk-action.ts` | 161-295 | Serial N+1 loop holds tx open for ~300 roundtrips on 100-row bulk. |
| **SW-2** | 🟡 Warning | `src/modules/members/application/use-cases/bulk-action.ts` | 49-52 (schema) | `member_ids` not deduped → same id processed twice → audit bloat / inconsistent state_error on retry. |
| **SW-3** | 🟡 Warning | `src/app/(staff)/admin/members/_components/bulk-progress-indicator.tsx` | 29-40 | FR-041 mandates **determinate** N-of-M indicator (SSE or polling). Impl is indeterminate CSS animation. Spec non-compliance with no plan.md deviation note. |
| **SW-4** | 🟡 Warning | `src/components/members/members-table.tsx` | (no handler) | FR-040 mandates **Ctrl+A page-select** + **"Select all N matching"** affordance. Neither implemented. Shift+Click range is fine. |
| **SW-5** | 🟡 Warning | `src/modules/members/application/use-cases/bulk-action.ts` | 218-261 | Bulk `change_plan` does NOT check `current.status !== 'archived'`. Archived members can be silently re-planned. Inconsistent with inline-edit & domain `archive()` rules. |
| **SW-6** | 🟡 Warning | `src/components/members/members-table.tsx` | 276-295, 393-414 | Escape+blur timing race — a stale-closure `handleSave` can still submit the draft after Escape (acknowledged in test file line 222-225). `savingRef` guards double-submit, not Escape-race. |
| **SS-1** | 🟢 Suggestion | `src/app/(staff)/admin/members/_components/directory-with-bulk.tsx` | 31-33 | `selectedCompanyNames` computed O(N·M) on every render — wrap in `useMemo`. |
| **SS-2** | 🟢 Suggestion | `src/modules/members/application/use-cases/bulk-action.ts` | 53-60 | `override_reason_*` lives on shared `params` object but only applies to `change_plan`. Use discriminated union for stricter shape. |
| **SS-3** | 🟢 Suggestion | `src/app/api/members/[memberId]/inline-edit/route.ts` | 65-93 | Optional Idempotency-Key is documented in comment but not in contracts/auth-api.md equivalent for F3. Client sends fresh UUID per call → idempotency effectively off; either formalize or remove the optional path. |
| **SS-4** | 🟢 Suggestion | `drizzle/migrations/meta/` | — | R4-I2 deferred (migration snapshots not regenerated for 0014/0015). User confirmed 0010-0013 follow the same convention — **accepted project pattern, NOT a blocker**. |
| **SS-5** | 🟢 Suggestion | `src/modules/members/application/ports/` | — | R4-I4 deferred (`findByIdInTx(tx, id)` vs `audit.recordInTx(tx, ctx, event)`). **Asymmetry is architecturally justified**: findByIdInTx relies on RLS `SET LOCAL app.current_tenant`; audit has an explicit `tenant_id` column, so `ctx` is needed. Not a blocker. |

---

## Detailed Analysis

### 🔴 SB-1 — TOCTOU in bulk-action (regression of round-3 N-C1 fix)

**Location**: `src/modules/members/application/use-cases/bulk-action.ts:169`

```ts
const result = await runInTenant(deps.tenant, async (tx) => {
  let updatedCount = 0;
  let auditEventCount = 0;

  for (const rawId of data.member_ids) {
    const memberId = asMemberId(rawId);

    // Fetch current member state
    const currentResult = await deps.memberRepo.findById(    // ← BUG: opens a SEPARATE tx
      deps.tenant,
      memberId,
    );
    ...
    const persistResult = await deps.memberRepo.updateStatusInTx(tx, ...);  // ← uses ambient tx
    const auditResult = await deps.audit.recordInTx(tx, ...);               // ← uses ambient tx
```

Look at the adapter impl (`drizzle-member-repo.ts:108-122`):

```ts
async findById(ctx, memberId) {
  try {
    const rows = await runInTenant(ctx, (tx) =>    // ← OPENS ITS OWN TRANSACTION
      tx.select().from(members)...
```

This means for each of the (up to 100) members:
1. The outer `runInTenant` holds ambient tx **T1** with an open connection
2. `findById(ctx, memberId)` acquires a **different** pool connection and opens tx **T2**
3. T2 reads the member WITHOUT a row lock (no `FOR UPDATE`)
4. T2 commits (separate connection returns to pool)
5. **A concurrent admin can now archive / change-plan the row**
6. Back in T1, `updateStatusInTx(tx, ...)` writes based on T2's stale snapshot
7. `audit.recordInTx` writes `old_plan_id: current.planId` — but that was the state T2 saw, not the real pre-write state

**Consequences**:
- **Lost update**: concurrent actor's archive/change-plan is silently overwritten.
- **Audit trail lies**: `old_plan_id` / `old_status` in the audit payload do not match the actual row state at the moment of the write. This violates Principle VIII (append-only audit trail integrity) — the immutable audit record becomes a false witness.
- **Principle I exposure**: cross-tenant RLS holds, but within-tenant integrity is broken.

**The fix is one-line per call site** — exactly the same change that was applied to inline-edit in
round 3:

```diff
- const currentResult = await deps.memberRepo.findById(deps.tenant, memberId);
+ const currentResult = await deps.memberRepo.findByIdInTx(tx, memberId);
```

`findByIdInTx` already exists on the port (`member-repo.ts:74-77`) and the Drizzle adapter
(`drizzle-member-repo.ts:124-140`) uses `.for('update')` which acquires a row lock that is
released on COMMIT / ROLLBACK of the ambient tx.

**Why tests missed it**: all bulk-action tests stub the repo (`findById` returns a fixed `stubMember`).
No test exercises two concurrent actors racing on the same member_id. A regression test should assert
that when one bulk tx is mid-flight, a second write must block or fail.

---

### 🟡 SW-1 — Serial N+1 loop holds tx for ~300 RTT on max batch

Per 100-row batch the loop does:
- 100× `findById(ctx, memberId)` (each opens+commits its own tx after SB-1 fix: 100× `findByIdInTx`
  which is lighter but still serial)
- 100× `updateStatusInTx` / `updateFieldsInTx`
- 100× `audit.recordInTx`

Total = 300 sequential DB roundtrips inside a single tx. At Neon Singapore ~5-15 ms RTT, that's
1.5 – 4.5 s of holding a row-locked transaction open while blocking concurrent readers of the same
rows.

**Fix paths** (pick one, or defer with a plan.md note):
- Batched lock: `SELECT ... WHERE member_id = ANY($1) FOR UPDATE` once; iterate in memory.
- Batched UPDATE: `UPDATE ... WHERE member_id = ANY($1) RETURNING *`.
- Keep findByIdInTx serial but parallelize audit writes after all updates succeed.

This is not a blocker because BULK_CAP caps worst-case latency, but should be scheduled before
a high-traffic launch.

---

### 🟡 SW-2 — Duplicate member_ids cause audit bloat

```ts
member_ids: z.array(z.string().uuid()).min(1).max(BULK_CAP)   // no uniqueness check
```

Client sending `["id-a", "id-a"]`:
- **archive**: 1st iter archives, 2nd iter reads now-archived row → `archive()` returns `state_error`
  → tx rolls back → user sees "state_error on member id-a". Confusing but defensive.
- **change_plan**: both iters succeed (UPDATE is idempotent). Audit log gets 2 events for the same
  change.
- **send_portal_invite**: 2 audit events for the same invite — pollutes timeline.

**Fix**: add uniqueness refinement at schema level.

```ts
.superRefine((data, ctx) => {
  ...
  const unique = new Set(data.member_ids);
  if (unique.size !== data.member_ids.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['member_ids'],
      message: 'member_ids must be unique',
    });
  }
});
```

---

### 🟡 SW-3 — FR-041 spec non-compliance (indeterminate vs determinate)

Spec verbatim (line 864-868):

> **FR-041**: When a bulk action affecting 50-100 rows exceeds a perceived-latency threshold of 1
> second, the UI MUST show a **determinate** progress indicator (N of 100 complete) driven by
> Server-Sent-Events or short-polling; below 1 s an optimistic update + final toast is sufficient.

Impl (`bulk-progress-indicator.tsx:29-40`): indeterminate CSS keyframe, no server progress feedback.

This is a spec deviation that should either be:
- (a) Implemented via SSE from `/api/members/bulk` streaming progress events, OR
- (b) Recorded in `plan.md § Complexity Tracking` with rationale (e.g., "indeterminate accepted for
  MVP because BULK_CAP=100 + N+1 keeps worst case under 5s; SSE deferred to F9")

Recommendation: option (b). Current UX is acceptable if spec is amended.

---

### 🟡 SW-4 — FR-040 keyboard shortcuts partially implemented

Spec (line 857-863):

> Multi-row selection keyboard shortcuts: Shift+Click range; Ctrl/Cmd+Click additive; Space toggle;
> Ctrl+A select all on current page; explicit "Select all N matching" affordance to cover >1 page.

| Shortcut | Status |
|---|---|
| Shift+Click range | ✅ `members-table.tsx:463-477` |
| Ctrl/Cmd+Click additive | ✅ (native checkbox) |
| Space toggle | ✅ (native checkbox) |
| **Ctrl+A page-select** | ❌ not implemented |
| **"Select all N matching"** affordance | ❌ not implemented |

**Fix**: add a `useEffect` keydown listener scoped to the table container:

```ts
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'a' &&
        tableRef.current?.contains(document.activeElement)) {
      e.preventDefault();
      table.toggleAllPageRowsSelected(true);
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [table]);
```

"Select all N matching" needs a small ghost button next to the header checkbox that appears when
`table.getIsAllPageRowsSelected()` is true and `nextCursor` is not null.

---

### 🟡 SW-5 — Bulk change_plan ignores archived state

```ts
case 'change_plan': {
  // Zod superRefine has already enforced that both fields are present
  ...
  const persistResult = await deps.memberRepo.updateFieldsInTx(tx, memberId, patch);
  ...
```

No state check. An archived member can be silently re-planned in bulk, which is inconsistent with:
- Domain `archive()` which rejects re-archiving (`state.cannot_archive_already_archived`)
- `inline-edit` which rejects status changes on archived members
- `setStatus` domain fn rules in general

**Fix**:
```ts
case 'change_plan': {
  if (current.status === 'archived') {
    throw new BulkStateError(rawId, 'state.cannot_change_plan_archived');
  }
  ...
```

---

### 🟡 SW-6 — Escape + blur stale-closure race in inline cells

The test file explicitly acknowledges the risk (line 222-225):

> N-I1 post-condition: on save failure, toast fires but edit mode must persist. We don't trigger
> blur/Enter here because of the known jsdom/React-19 timing flakiness

In a real browser, pressing Escape queues `setEditing(null)`. Some browsers fire the input's `blur`
event before unmount, and the queued blur handler still holds the **old** closure (where `editing`
was set to the draft). The `savingRef` guard prevents double-submit but does not block the stale
submission.

**Fix** — add a cancellation flag:

```ts
const cancellingRef = useRef(false);

const handleSave = useCallback(async () => {
  if (cancellingRef.current || !onSave || editing === null || savingRef.current) return;
  ...
});

// In onKeyDown:
} else if (e.key === 'Escape') {
  e.preventDefault();
  cancellingRef.current = true;
  setEditing(null);
  // Next tick reset
  queueMicrotask(() => { cancellingRef.current = false; });
}
```

---

## Spec Coverage Matrix

| FR | Description | Coverage |
|---|---|---|
| FR-018 | Inline-edit status/country/notes | ✅ implemented |
| FR-019 | All-or-nothing bulk txn | ⚠️ SB-1 breaks integrity guarantee |
| FR-019a | 100-row cap (UI + server) | ✅ dual layer |
| FR-019b | Rate limit 10 / 10 min per actor + audit | ✅ implemented at route layer |
| FR-040 | Bulk bar + keyboard shortcuts | ⚠️ partial — SW-4 |
| FR-041 | Determinate progress indicator | ❌ indeterminate — SW-3 |

---

## Test Coverage Assessment

**Solid coverage**:
- Bulk: 6 contract + 4 cap + 3 rate-limit + 5 branches + 5 live-Neon status-tx = 23 tests
- Inline-edit: 9 contract + 13 integration + 11 presentation = 33 tests
- E2E: row selection, bulk bar visibility, axe-core, EN/TH/SV leak

**Gaps**:
- ❌ No **TOCTOU concurrency** integration test (would have caught SB-1)
- ❌ No **duplicate-ids** test (would catch SW-2)
- ❌ No **archived-member change-plan** test (would catch SW-5)
- ❌ No **e2e inline-edit** (tests exist but acknowledge Escape+blur flakiness — needs real-browser coverage)

---

## Metrics

| Category | Value |
|---|---|
| Commits on branch (US4 only) | 5 |
| Files touched (US4 only) | 45 |
| Lines added | +4,877 |
| Total findings | 12 |
| 🔴 Blockers | 1 |
| 🟡 Warnings | 6 |
| 🟢 Suggestions | 5 |
| Spec requirements covered | 4/6 fully, 2 partial |

---

## Recommended Actions (prioritized)

### P0 — Must fix before ship
1. **SB-1**: Replace `findById` with `findByIdInTx` in `bulk-action.ts` (3 call sites if you count
   archive/change_plan/send_portal_invite branches; in the current code only the archive & change_plan
   branches need the fetch — send_portal_invite doesn't need a fetch because it only audit-logs.
   Actually the current loop does `findById` **once at top** before the switch → one edit.)
2. Add TOCTOU regression test: two concurrent `bulkAction` tasks racing on the same member_id; assert
   the second blocks (via row lock) and sees the first's committed state.

### P1 — Should fix before ship
3. **SW-2**: Add `.refine()` for unique member_ids in zod schema.
4. **SW-5**: Add archived-state check in `change_plan` branch.
5. **SW-3 / SW-4**: Either implement, OR add a plan.md § Complexity Tracking entry documenting the
   deferral with rationale.

### P2 — Nice to fix before ship
6. **SW-1**: Schedule a batched-SQL optimization follow-up; document max-latency budget.
7. **SW-6**: Add `cancellingRef` guard in inline cells.
8. **SS-1/SS-2/SS-3**: polish pass.

### Acknowledged deferrals (not blockers)
- **R4-I2** (SS-4): migration snapshots — project convention, 0010-0013 follow same pattern.
- **R4-I4** (SS-5): port-signature asymmetry — architecturally justified (RLS vs explicit tenant_id).

---

## Verdict

❌ **CHANGES REQUIRED**

SB-1 is a Principle I / Principle VIII exposure and must be fixed. Warnings should be triaged into
"fix now" vs "plan.md deviation" per the team's risk appetite — my recommendation is to fix SW-2 and
SW-5 inline with the SB-1 fix (small), document SW-3 and SW-4 as deferred in plan.md, and schedule
SW-1 and SW-6 as follow-ups.

Next step after P0 fixes: re-run `/speckit.review` (or a lighter `pnpm test:integration`) focused on
the bulk-action suite + the new TOCTOU test.
