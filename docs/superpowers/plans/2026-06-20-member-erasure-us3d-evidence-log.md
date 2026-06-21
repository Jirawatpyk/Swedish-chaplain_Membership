# COMP-1 US3-D — DPO Erasure-Evidence Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only admin page `/admin/compliance/erasure-log` that gives the DPO a single accountable view of every member erasure + its full Art.17 evidence (incl. the tenant-NULL `user_erased` proof) + a half-run (incomplete) flag.

**Architecture:** A dedicated `erasureEvidenceReadAdapter` (auth/infrastructure) whose query UNIONs the tenant-scoped erasure events with the tenant-NULL `user_erased` rows joined by `target_user_id` — the member's linked user ids resolved via a new members-barrel free-function. The deliberate tenant-NULL read is scoped strictly to the member's own linked users and is DROPPED entirely when the member has no linked login (security FIX-1). A use-case groups the evidence by member + flags half-runs; the page reuses the F9 audit-viewer shell. Read-only, no migration.

**Tech Stack:** TypeScript strict, Drizzle (`runInTenant` + keyset), Next.js 16 App Router (RSC), next-intl (EN/TH/SV), shadcn/ui, Vitest + live-Neon integration + Playwright (`@a11y`/`@i18n`).

---

## Grounding (verified against current code)

- **The PERMISSIVE RLS hazard (the whole reason this feature is delicate):** `audit_log_tenant_isolation` is PERMISSIVE — `tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant')` (migration 0007). So tenant-NULL rows (the F1 `user_erased` identity events) are visible to EVERY tenant at the DB layer; the ONLY cross-tenant wall for them is the app-layer `WHERE tenant_id = ctx.slug` predicate that the F9 readers apply (`audit-query-repo.ts:36`). US3-D's reader DELIBERATELY removes that wall for ONE event (`user_erased`), so it MUST re-impose a strict bound (`target_user_id = ANY(<member's own linked users>)`) and DROP the arm when that set is empty.
- **`audit_log` columns** (`auth/infrastructure/db/schema.ts:518`): `id`, `timestamp` (timestamptz), `eventType` (enum), `actorUserId` (text), `targetUserId` (uuid, nullable), `summary`, `requestId`, `payload` (jsonb, nullable), `tenantId` (text, nullable).
- **The F9 reader template** (`auth/infrastructure/db/audit-query-repo.ts`): `runInTenant(ctx, tx)` → `eq(auditLog.tenantId, ctx.slug)` + filters + keyset on `(timestamp DESC, id DESC)`. Mirror its structure + its PERMISSIVE-RLS docblock.
- **Linked user ids:** `contactRepo.listAllLinkedUserIdsForMemberInTx(tx, memberId)` (members, `contact-repo.ts:175`) returns the member's UNFILTERED linked user ids — survives the erasure scrub (`linked_user_id` is not nulled). NOT exposed via the members barrel yet (Task 1 adds a free-function wrapper).
- **Roles / RBAC (plan-review CWE-285 fix):** Chamber-OS has 3 roles (`admin`/`manager`/`member`) — NO distinct DPO role. The admin acts as DPO → **admin-only**. ⚠️ `requireAdminContext` (`src/lib/admin-context.ts`) is a ROUTE-HANDLER helper (takes `NextRequest`, returns a `NextResponse`) — it does NOT work in an RSC `page.tsx`. The F9 audit page uses `requireSession('staff')`, which ALSO admits `manager`. So US3-D's page MUST do `requireSession('staff')` THEN `if (user.role !== 'admin') notFound()` (mirror `admin/audit/page.tsx:75` + the explicit role check) — a bare staff-gate would LEAK erasure evidence to managers. The e2e MUST assert a manager is denied (notFound/redirect).
- **Feature flag (plan-review B):** the reused F9 audit-page shell gates on `FEATURE_F9_DASHBOARD` — but US3-D is COMP-1, NOT F9. Do NOT couple to that flag. Ship the page **UNGATED** (consistent with US3-A's admin erase UI, already live) — do NOT copy the `FEATURE_F9_DASHBOARD` guard from the audit-page shell.
- **The evidence event set** (what the page surfaces, M-3 full lifecycle): tenant-scoped (`payload->>'member_id' = memberId`): `member_erasure_requested`, `member_erased`, `event_buyer_pii_redacted` (US3-B tax redaction — member-arm carries `member_id`), `subprocessor_erasure_propagated` (US3-C); PLUS the tenant-NULL `user_erased` (joined by `target_user_id`).

---

## File Structure

**Create:**
- `src/modules/auth/application/erasure-evidence-read.ts` — `ErasureEvidenceReadPort` + row/filter types.
- `src/modules/auth/infrastructure/db/erasure-evidence-repo.ts` — `erasureEvidenceReadAdapter` (the union query + FIX-1).
- `src/modules/insights/application/erasure-evidence.ts` (or a compliance area) — the `getErasureEvidenceLog` use-case (resolve ids → read → group-by-member + half-run + lifecycle shaping).
- `src/app/(staff)/admin/compliance/erasure-log/page.tsx` + `loading.tsx` + `error.tsx` — the page (RSC, admin-only).
- i18n keys under `admin.compliance.erasureLog.*` in `src/i18n/messages/{en,th,sv}.json`.
- Tests: `tests/integration/auth/erasure-evidence-repo.test.ts` (the crux — union, empty-set, cross-tenant, adversarial shared-user), `tests/unit/auth/erasure-evidence-empty-set.test.ts` (FIX-1 no-unbounded-read proof), `tests/unit/members/list-member-linked-user-ids.test.ts`, `tests/e2e/admin-erasure-log.spec.ts` (`@a11y`/`@i18n`).

**Modify:**
- `src/modules/members/index.ts` — export `listMemberLinkedUserIds`.
- `src/modules/members/members-deps.ts` (or a free-function file) — the barrel wrapper.
- `src/components/layout/**` admin nav — add the Compliance → Erasure Log entry (admin-only).

---

## Task 1: members barrel — `listMemberLinkedUserIds(ctx, memberId)`

**Files:** Modify `src/modules/members/index.ts` + add the free-function (mirror the US3-A `getMemberErasureStatus` barrel free-function pattern). Test: `tests/unit/members/list-member-linked-user-ids.test.ts`.

- [ ] **Step 1: Write the failing test** — `listMemberLinkedUserIds(ctx, 'm-1')` returns the member's linked user ids (a `string[]`), resolving `listAllLinkedUserIdsForMemberInTx` inside `runInTenant`. Assert it returns `[]` for a member with no linked logins.
- [ ] **Step 2: Run RED.**
- [ ] **Step 3: Implement** — a free function (co-located like US3-A's `getMemberErasureStatus`):
```ts
export async function listMemberLinkedUserIds(
  ctx: TenantContext,
  memberId: MemberId,
): Promise<readonly string[]> {
  return runInTenant(ctx, (tx) =>
    drizzleContactRepo.listAllLinkedUserIdsForMemberInTx(tx, memberId),
  );
}
```
Export it from `src/modules/members/index.ts` (barrel). (`listAllLinkedUserIdsForMemberInTx` already returns `Promise<readonly string[]>` — no branded-adapt needed; plan-review C.)
- [ ] **Step 3b: `listErasedMembers` keyset read** (plan-review architect note — no such fn exists yet). Add a second narrow members-barrel free-function `listErasedMembers(ctx, { limit, cursor }): Promise<{ rows: ErasedMemberRow[]; nextCursor: ... }>` that selects `members WHERE erased_at IS NOT NULL` (keyset on `(erased_at DESC, member_id DESC)`), returning `{ memberId, memberNumber, erasedAt }` per row — the Task-3 use-case pages over THIS list, then fetches per-member evidence. Co-locate + barrel-export it; unit/integration test it.
- [ ] **Step 4: GREEN + commit** — `feat(members): listMemberLinkedUserIds + listErasedMembers barrel fns (COMP-1 US3-D)`.

---

## Task 2: the security-critical evidence reader (the CRUX)

**Files:** Create `src/modules/auth/application/erasure-evidence-read.ts` + `src/modules/auth/infrastructure/db/erasure-evidence-repo.ts`. Tests: `tests/integration/auth/erasure-evidence-repo.test.ts` + `tests/unit/auth/erasure-evidence-empty-set.test.ts`.

> ⚠️ This is the SECURITY-CRITICAL task (PERMISSIVE-RLS tenant-NULL read). FIX-1 + FIX-2 below are gate-blockers; the security review signs this task.

- [ ] **Step 1: Port** `erasure-evidence-read.ts`:
```ts
import type { TenantContext } from '@/modules/tenants';

export interface ErasureEvidenceRow {
  readonly id: string;
  readonly eventType: string; // member_erasure_requested | member_erased | event_buyer_pii_redacted | subprocessor_erasure_propagated | user_erased
  readonly occurredAtIso: string;
  readonly actorUserId: string;
  readonly targetUserId: string | null;
  readonly payload: Record<string, unknown> | null;
}

export interface ErasureEvidenceReadPort {
  /**
   * Read ONE member's full erasure evidence. `memberLinkedUserIds` MUST be the
   * member's own linked user ids (resolved upstream). When EMPTY, the tenant-NULL
   * `user_erased` arm is DROPPED — see FIX-1.
   */
  readForMember(
    ctx: TenantContext,
    memberId: string,
    memberLinkedUserIds: readonly string[],
  ): Promise<readonly ErasureEvidenceRow[]>;
}
```

- [ ] **Step 2: Write the FAILING integration tests** (live Neon) — `erasure-evidence-repo.test.ts`. Seed 2 tenants. Cases:
  1. **Union (load-bearing):** an erased member of tenant-A with a linked user → the result includes BOTH the tenant-scoped `member_erasure_requested`/`member_erased` (matched by `payload->>'member_id'`) AND the tenant-NULL `user_erased` (matched by `target_user_id`).
  2. **Lifecycle (M-3 + pdpa H-1):** seed BOTH an INVOICE-arm (`document_kind:'invoice'`) AND a CREDIT-NOTE-arm (`document_kind:'credit_note'`) `event_buyer_pii_redacted` row (both carry `payload->>'member_id'` per US3-B — verified) + a `subprocessor_erasure_propagated` for the member → ALL THREE appear, and the use-case/page surfaces the `document_kind` discriminator (invoice vs credit-note redaction).
  3. **FIX-1 empty-linked-users:** a member with NO linked login → `readForMember(ctx, memberId, [])` returns ONLY the tenant-scoped rows; assert NO `user_erased` row leaks (seed a tenant-NULL `user_erased` for an UNRELATED user + assert it's absent).
  4. **Cross-tenant (Principle-I gate-blocker):** tenant-B's erasure events for a DIFFERENT member are NOT returned for tenant-A's query.
  5. **FIX-2 adversarial shared-user (STRUCTURALLY-IMPOSSIBLE-BUT-DEFENSIVE — plan-review):** the scenario "an erased user U linked to a member in BOTH tenant A + B" is impossible by construction (US2a: each `users.id` belongs to ONE member's contact lineage + the global `lower(email)` unique on `users`). KEEP the test anyway as a defensive regression pin: directly seed a tenant-NULL `user_erased` (target_user_id=U) + a tenant-B tenant-SCOPED `member_erased` for a member-B, then assert tenant-A's `readForMember(memberA, [U])` returns U's `user_erased` (the bound matches) but NEVER tenant-B's tenant-scoped events (the tenant arm's `tenant_id = A.slug` excludes them). Note in the test that the cross-tenant-shared-login premise can't occur in prod.

- [ ] **Step 3: Run RED.**

- [ ] **Step 4: Implement the adapter** `erasure-evidence-repo.ts` (mirror `audit-query-repo.ts`'s structure + PERMISSIVE-RLS docblock). The query:
```ts
export const erasureEvidenceReadAdapter: ErasureEvidenceReadPort = {
  async readForMember(ctx, memberId, memberLinkedUserIds) {
    return runInTenant(ctx, async (tx) => {
      // Arm A — tenant-scoped erasure lifecycle events for THIS member.
      const tenantArm = and(
        eq(auditLog.tenantId, ctx.slug),
        inArray(auditLog.eventType, [
          'member_erasure_requested', 'member_erased',
          'event_buyer_pii_redacted', 'subprocessor_erasure_propagated',
        ]),
        sql`${auditLog.payload}->>'member_id' = ${memberId}`,
      );

      // Arm B — the tenant-NULL `user_erased` proof, joined by target_user_id.
      // FIX-1: ONLY when the member has ≥1 linked login. An empty `ANY('{}')`
      // or an unbounded tenant-NULL read would leak EVERY tenant's user_erased
      // rows (PERMISSIVE RLS). So the arm is OMITTED entirely when the set is
      // empty — there is NO code path that issues `tenant_id IS NULL AND
      // event_type='user_erased'` without a non-empty target_user_id bound.
      const where =
        memberLinkedUserIds.length > 0
          ? or(
              tenantArm,
              and(
                sql`${auditLog.tenantId} IS NULL`,
                eq(auditLog.eventType, 'user_erased'),
                // B-1 (plan-review, drizzle): bind as ANY(ARRAY[...]::uuid[]) —
                // NOT inArray(uuidCol, jsArray), which trips the Neon serverless
                // "argument must be of type string" class (the US3-C lesson).
                // Cast ::uuid[] (the column is uuid); NO lower-case (it's a uuid,
                // not an email). The set is non-empty here (the length>0 guard).
                sql`${auditLog.targetUserId} = ANY(ARRAY[${sql.join(
                  memberLinkedUserIds.map((id) => sql`${id}`),
                  sql`, `,
                )}]::uuid[])`,
              ),
            )
          : tenantArm;

      const rows = await tx
        .select({ id: auditLog.id, eventType: auditLog.eventType,
          occurredAtIso: sql<string>`${auditLog.timestamp}::text`,
          actorUserId: auditLog.actorUserId, targetUserId: auditLog.targetUserId,
          payload: auditLog.payload })
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.timestamp), desc(auditLog.id));

      return rows.map((r) => ({ ...r, payload: (r.payload as Record<string, unknown> | null) ?? null }));
    });
  },
};
```
NOTE (drizzle R-2): `inArray(col, [])` in Drizzle emits a constant `false` (NOT `IN ()`), so an accidental empty Arm B would be safe-by-Drizzle — but DO NOT rely on that. The FIX-1 guard OMITS the arm STRUCTURALLY (`length > 0 ? or(tenantArm, armB) : tenantArm`) so the auditable contract the security review reads is "no tenant-NULL / `user_erased` arm is even BUILT when the set is empty", not "Drizzle happens to neutralise it". Keep the explicit ternary.
INDEX (drizzle R-1, accepted): Arm A is backed by the 0190 `(tenant_id, event_type, timestamp DESC)` composite. Arm B (`tenant_id IS NULL AND event_type='user_erased' AND target_user_id = ANY(...)`) cannot use those composites (they lead with `tenant_id`, unusable for `IS NULL`); it relies on the single-col `audit_log_target_idx` on `target_user_id`. Acceptable for this read-only, low-volume (per-member, ≤ a handful of linked users) evidence query — documented, not optimised.

- [ ] **Step 5: Write the FIX-1 unit/contract test** `erasure-evidence-empty-set.test.ts` — a STRUCTURAL proof that with `memberLinkedUserIds = []`, the built query emits NO tenant-NULL `user_erased` arm. **plan-review M-1 + R-3: assert against BOTH the `.toSQL().sql` text AND the `.toSQL().params`** — `'user_erased'` is a BOUND PARAM (not literal in the sql text), so a text-only grep would miss it. Assert the params array does NOT contain `'user_erased'` AND the sql text contains no second `is null`/`target_user_id = any` fragment when the set is empty (and DOES when non-empty — the positive control). This single test is the regression wall for the PERMISSIVE-RLS leak.

- [ ] **Step 6: GREEN (all 5 integration + the FIX-1 unit) + commit** — `feat(auth): erasure-evidence reader with tenant-NULL user_erased union (COMP-1 US3-D)`.

---

## Task 3: the `getErasureEvidenceLog` use-case (group + half-run + lifecycle)

**Files:** Create `src/modules/insights/application/erasure-evidence.ts` + its deps factory. Test: `tests/unit/insights/erasure-evidence.test.ts`.

- [ ] **Step 1: Write the failing test** — given a set of erased members (from `listErasedMembers`) + per-member evidence, the use-case returns rows grouped by member, each carrying: `requestedAt` + `reason` + the US3-A attestation (`identity_verified` / `verification_method` / `note` from the `member_erasure_requested` payload) · `erasedAt` (from `member_erased`, or null) · the cascade counts (from `member_erased` payload) · the `user_erased` proof(s) (occurredAt + outcome ONLY, no actor id — M-2) · the US3-B (with `document_kind`) + US3-C outcomes · `halfRun: boolean` (`member_erasure_requested` present AND `member_erased` absent) · **H-2: `overdueAt` / `isOverdue`** — `requestedAt + STATUTORY_WINDOW < now` (the tighter PDPA 30-day window; pass `now` IN as a param — `Date.now()`/`new Date()` are unavailable in some contexts + must be injectable for the test). Assert a half-run member is flagged AND that a >30-day-old half-run is `isOverdue:true` while a fresh one is `false`.

- [ ] **Step 2: RED.**

- [ ] **Step 3: Implement** — the use-case pages over `listErasedMembers` (keyset) → for each, resolve `listMemberLinkedUserIds` (members barrel) → `erasureEvidenceReadAdapter.readForMember` → fold the rows into the grouped shape + the `halfRun` flag + the `isOverdue` computation (`requestedAt + 30d < now`, `now` injected) + cross-link the US2d `members_erasure_outcome_total{still_pending}` signal (doc reference, not a query). Page-level keyset over the member list.

- [ ] **Step 4: GREEN + commit** — `feat(insights): getErasureEvidenceLog use-case — grouped evidence + half-run flag (COMP-1 US3-D)`.

---

## Task 4: the page + RBAC + i18n

**Files:** Create `src/app/(staff)/admin/compliance/erasure-log/page.tsx` + `loading.tsx` + `error.tsx`. Add i18n keys. Mirror the F9 audit page (`src/app/(staff)/admin/audit/page.tsx`) shell + `check:layout` container.

- [ ] **Step 1:** RSC page — `requireSession('staff')` THEN `if (user.role !== 'admin') notFound()` (admin-only; manager + member → notFound; NOT `requireAdminContext`, which is route-handler-only — see Grounding § Roles/RBAC). UNGATED (no `FEATURE_F9_DASHBOARD`). Calls `getErasureEvidenceLog`, renders the grouped evidence (one card/section per erased member) with:
  - the requested/attestation block (requested-at + reason + the US3-A Art.12 attestation + note);
  - the completion block (erased-at + cascade outcomes);
  - the `user_erased` proof(s) — **M-2 (plan-review): render ONLY occurredAt + "credential erased" outcome; do NOT echo the row's `actor_user_id`** (for a [structurally-impossible-but-defensive] shared login it could be another tenant's admin id — app-layer minimisation);
  - **the US3-B tax-redaction outcome** — **H-1 (plan-review): render the `document_kind` discriminator** (invoice vs credit_note) so the DPO can tell which document's PII was redacted — **and the US3-C sub-processor outcome** (the full lifecycle, M-3);
  - **H-2 (plan-review): a prominent half-run / OVERDUE badge.** A half-run (`member_erasure_requested` present, `member_erased` absent) shows the **elapsed time since requested-at**, and an **OVERDUE/breach** state when `requested-at + statutory window < now` (Art.12 one-month / PDPA §30 30-day — default to the tighter 30-day for dual subjects). Cross-link the US2d reconciler / `members_erasure_outcome_total{still_pending}` note. Without the elapsed dimension the DPO can't tell "requested 10 min ago, reconciler will finish" from "requested 6 weeks ago = reportable breach".
  Keyset "load more" over the member list. Read-only — NO actions.
- [ ] **Step 2:** `loading.tsx` (shimmer, audit-page-shaped) + `error.tsx`. A `check:layout` container (the page is a DetailContainer/Table — not a redirect page).
- [ ] **Step 3:** i18n keys `admin.compliance.erasureLog.*` in EN (canonical) + TH + SV — title, column/field labels, the half-run warning, the empty-state, the attestation labels, the lifecycle-outcome labels. Run `pnpm check:i18n` → all 3 locales present.
- [ ] **Step 4:** Admin nav entry (Compliance → Erasure Log), admin-only visibility.
- [ ] **Step 5: typecheck + lint + check:layout + check:i18n + commit** — `feat(admin): erasure-evidence log page /admin/compliance/erasure-log (COMP-1 US3-D)`.

---

## Task 5: e2e + final gates

**Files:** `tests/e2e/admin-erasure-log.spec.ts` (`@a11y`/`@i18n`).

- [ ] **Step 1:** e2e — an admin sees the erasure-log page with a known erased member's evidence (seed via the E2E_ADMIN creds + a seeded erased member); a manager/member is forbidden (RBAC); `@a11y` axe scan clean; `@i18n` the 3 locales render (no MISSING_MESSAGE). Run with `--workers=1`.
- [ ] **Step 2:** Full gate sweep — true typecheck (temp tsconfig excl `.next`) 0, `pnpm lint` 0, `check:i18n`/`check:layout`/`check:fixme`/`check:multi-tenant`, the US3-D unit + integration green, the architecture guards green.
- [ ] **Step 3: commit** — `test(admin): e2e + a11y/i18n for the erasure-evidence log (COMP-1 US3-D)`.

---

## Security review (mandatory — PII/audit/cross-tenant surface, ≥2 reviewers)

The security-engineer + pdpa-gdpr-compliance-officer MUST sign:
- **FIX-1:** the empty-linked-users path DROPS the `user_erased` arm — verified by the integration test (no leak) + the FIX-1 structural unit test (no unbounded tenant-NULL SQL emitted). The ONLY tenant-NULL read is bounded by `target_user_id = ANY(<member's own linked users>)`.
- **FIX-2:** the adversarial shared-user case — tenant-A's DPO sees the shared user's `user_erased` (correct) but NOT tenant-B's tenant-scoped erasure events.
- **Principle-I gate-blocker:** a genuine 2-tenant cross-tenant integration test.
- The page is read-only + admin-only (RBAC 401-before-403); no PII beyond what the audit rows already hold; no new write path.

## Self-Review (completed)

- **Spec coverage:** design § US3-D → dedicated reader (T2) ✓, tenant-NULL union by target_user_id (T2) ✓, FIX-1 empty-drop + unit test (T2 Step 5) ✓, FIX-2 adversarial shared-user (T2 Step 2.5) ✓, lifecycle US3-B+US3-C outcomes (T2/T3) ✓, half-run flag (T3) ✓, grouped-by-member page + admin-only + read-only (T4) ✓, i18n EN/TH/SV (T4) ✓, no migration ✓, e2e @a11y/@i18n (T5) ✓, the SHARED-user_id + cross-tenant gate-blockers (T2) ✓.
- **Out of scope (design):** CSV/PDF export of the evidence (follow-up); editing/acting on erasures (read-only). Noted.
- **Type consistency:** `ErasureEvidenceReadPort.readForMember(ctx, memberId, memberLinkedUserIds)` is used identically in T2 (adapter) + T3 (use-case). `listMemberLinkedUserIds` (T1) feeds T3 which feeds T2.

## Execution Handoff

Two options:
1. **Subagent-Driven (recommended)** — fresh subagent per task + two-stage review; T2 gets a security review (FIX-1/FIX-2 are gate-blockers).
2. **Inline Execution** — batch with checkpoints.

**Plan-review-first: DONE (2026-06-20).** All 4 specialists APPROVE-WITH-CHANGES / SIGN-WITH-CONDITIONS; the FIX-1/FIX-2 crux is structurally sound (FIX-1 omission has codebase precedent; FIX-2 is structurally-impossible-but-defensive — single-lineage + global email-unique). Findings folded:
- **security-engineer** — SIGN-WITH-CONDITIONS: FIX-1/FIX-2/bound safe. Folded: the RBAC fix (`requireSession('staff')`+role-check, not `requireAdminContext`); FIX-2 noted impossible-but-defensive. Signs Task 2 after the live-Neon cross-tenant test is green.
- **chamber-os-architect** — APPROVE-WITH-CHANGES: dedicated-adapter (N1) honored, Clean Arch PASS. Folded: RBAC (A), feature-flag-not-F9 (B), Task-1 no-op caveat dropped (C), `listErasedMembers` added.
- **pdpa-gdpr** — APPROVE-WITH-CHANGES: Folded H-1 (both invoice+credit-note `document_kind` lifecycle test+render), H-2 (overdue/Art.12-clock), M-1 (FIX-1 test asserts SQL+params), M-2 (user_erased render = occurredAt+outcome, no actor id). Export-deferral acceptable; flagged for US3-E runbook.
- **drizzle-migration-reviewer** — APPROVE-WITH-CHANGES: Folded B-1 (`= ANY(ARRAY[...]::uuid[])` not `inArray`), R-1 (index verdict noted), R-2 (`inArray([])`→`false` comment fixed), R-3 (assert `.toSQL()` params).

No NON-NEGOTIABLE blockers. Build-ready; the security checklist final sign + the cross-tenant gate-blocker land at the Task-2 implementation review.
