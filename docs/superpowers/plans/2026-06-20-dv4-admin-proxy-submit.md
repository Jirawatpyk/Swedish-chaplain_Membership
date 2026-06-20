# DV-4 Admin Proxy-Submit (Submit on behalf of member) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the admin "Submit on behalf of member" UI for F7 broadcasts (the backend use-case + route + i18n already exist), and while wiring it close two pre-existing divergences: the admin_proxy quota-cap bypass (security T-10) and the proxy-submit double member read (deferred finding #18).

**Architecture:** Three concerns, three commit groups, bundled in one PR off `main` (branch `085-dv4-admin-proxy-submit`, worktree `.claude/worktrees/dv4`):
1. **Quota-cap fairness fix (T-10)** — `submitBroadcast` currently skips the member quota cap when `actorRole==='admin_proxy'`. Remove that guard so the proxied member's cap is enforced for admin submissions too; keep the rate-limit precondition (d) exactly as-is.
2. **#18 read-dedup** — the proxy route reads the member once (`drizzleMemberRepo.findById`, for DV-17 `companyName`) and the use-case reads it again (`membersBridge.memberExistsInTenant`, for the not-found/infra distinction). Collapse to a single read by passing the route's lookup outcome into the use-case as a discriminated input.
3. **Admin UI** — a new admin-only page `/admin/broadcasts/new` that reuses the existing compose sub-components (Tiptap body, segment/schedule pickers, preview, submit) plus a new `member-picker.tsx` that *mirrors* (does not refactor) the relink dialog's cmdk member-search. A thin `proxy-compose-form.tsx` orchestrates and POSTs to the existing `/api/admin/broadcasts/proxy-submit` route. An entry button on the `/admin/broadcasts` header opens the page.

**Tech Stack:** Next.js 16 App Router (RSC) + React 19 · TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) · Drizzle + Neon Postgres (RLS via `runInTenant`) · next-intl (en/th/sv, en canonical) · cmdk (member search) · Tiptap (body) · sonner (toasts) · Vitest (unit/integration) + Playwright (e2e, `--workers=1`).

## Global Constraints

- **Language:** code/comments/commits in English; the *conversational* turns with the user are Thai (not relevant to file contents).
- **Commit footer (every commit):** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Conventional Commits enforced by commit-msg hook.
- **PR footer:** `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Do NOT edit `src/modules/broadcasts/index.ts`** (the public barrel) — a concurrent COMP-1 session holds conflicting changes there. All new exports for this feature must be reached without touching that file (the proxy route already imports `proxySubmitBroadcast` / `makeProxySubmitBroadcastDeps` / `ProxySubmitBroadcastError` from the barrel — those already exist; the `ProxyMemberLookup` type in Task 3 is imported directly from the use-case module path, not the barrel).
- **Tenant isolation (Principle I, NON-NEGOTIABLE):** every DB read/write is tenant-scoped via `runInTenant`/RLS; a cross-tenant proxy integration test is a Review-Gate blocker (Task 2b).
- **Clean Architecture (Principle III):** presentation (`src/app/**`, `src/components/**`) calls application use-cases only; no nested ternaries in presentation (use `switch`/`if`); application layer has no React/Next/Drizzle imports.
- **TDD (Principle II, NON-NEGOTIABLE):** failing test → commit red → implement → commit green. Security-critical use-cases (submit-broadcast) require 100% branch coverage — do not drop a branch.
- **i18n:** every new key present in **en + th + sv** (en canonical). Missing en fails the build; missing th/sv CI-blocks on release. Renaming an existing key requires updating every consumer (runtime `MISSING_MESSAGE` trap) — this plan only *adds* keys.
- **Push:** broadcasts integration tests are RED on shared Neon from an unrelated COMP-1 enum drift (`broadcast_content_redacted`). Push with `SKIP_INTEGRATION_PREPUSH=1 git push` and run the affected integration tests manually (Task 2, Task 7). Never add the orphan enum value to the TS tuple.
- **E2E:** always `--workers=1` (default 3 hangs the workstation). Never start/stop the dev server on :3100 (the user runs it). Never seed real members — use the `E2E_MEMBER_*` fixture identity only.
- **Worktree:** all work happens in `.claude/worktrees/dv4`. Do not disturb the concurrent COMP-1 session on the main checkout.

---

## Authoritative spec evidence (why the quota fix direction is correct)

The quota-cap fix is a **semantic** correctness change, so its direction was verified against the spec before planning (per `feedback_audit_direction_can_be_wrong`):

- `specs/010-email-broadcast/spec.md:87` (Q12): "quota counts against the member regardless … never gets free broadcasts."
- `specs/010-email-broadcast/spec.md:136` (AS9): admin proxy "quota slot reserved against [the member]."
- `specs/010-email-broadcast/security.md:17` (CHK005 / threat **T-10**): "admin cannot bypass quota."
- The word "emergency" appears only in `data-model.md:641` + quickstart §11 (the unrelated `READ_ONLY_MODE` freeze) — **not** in Q12. The `submit-broadcast.ts:329` comment "admin emergency correction path" and the route comment "Q12 emergency correction" are **unsupported**; the bypass is the bug. Fix direction = **enforce the cap**; keep the rate-limit pass-through (precondition d) untouched.

---

## File Structure

**Modify (application / route):**
- `src/modules/broadcasts/application/use-cases/submit-broadcast.ts` — remove precondition-(b) admin_proxy guard; fix header + inline comments.
- `src/modules/broadcasts/application/use-cases/proxy-submit-broadcast.ts` — replace `memberDisplayName` field + `memberExistsInTenant` probe with a discriminated `memberLookup` input.
- `src/app/api/admin/broadcasts/proxy-submit/route.ts` — map `findById` outcome → `memberLookup`; fix header comment.

**Modify (presentation — small surgical changes):**
- `src/components/broadcast/compose-form.tsx` — `export` the existing `buildSegmentPayload` (no behaviour change).
- `src/app/(staff)/admin/broadcasts/page.tsx` — add the entry button to the header.
- `src/i18n/messages/{en,th,sv}.json` — add proxy microcopy keys.

**Create (presentation):**
- `src/components/broadcast/member-picker.tsx` — cmdk member search (mirrors relink-registration-dialog's search block).
- `src/components/broadcast/proxy-compose-form.tsx` — thin admin orchestrator; POSTs to `/api/admin/broadcasts/proxy-submit`.
- `src/app/(staff)/admin/broadcasts/new/page.tsx` — admin-only server page hosting `<ProxyComposeForm/>`.

**Create (tests):**
- `tests/integration/broadcasts/proxy-submit-quota-cap.integration.test.ts` — at-cap admin_proxy → blocked (Task 2a).
- `tests/integration/broadcasts/proxy-submit-cross-tenant.integration.test.ts` — cross-tenant proxy isolation (Task 2b).
- `tests/unit/broadcast/member-picker.test.tsx` — picker render/behaviour (jsdom-safe).
- `tests/unit/broadcast/build-segment-payload.test.ts` — exported helper unit test.
- `tests/e2e/admin-proxy-submit.spec.ts` — AS9 full-submit + manager-403 + member-403 + admin-only-button.

**Modify (tests):**
- `tests/unit/broadcasts/application/submit-broadcast.test.ts` — flip the admin_proxy quota-bypass test (`:500`).
- `tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts` — flip the 2 quota-bypass tests (`:399`,`:414`); migrate existence tests to the discriminated input.
- `tests/contract/broadcasts/post-admin-broadcasts-proxy-submit.contract.test.ts` — keep green through #18; add at-cap 422 assertion.

---

## Task 1: Quota-cap fairness fix (T-10) — enforce member cap on admin_proxy submit

**Commit group 1.** Security-critical (submit-broadcast — 100% branch). This task makes `broadcast_quota_blocked` reachable for `admin_proxy`; the proxy route already maps that code to 422 via `httpStatusForBroadcastError` (`broadcasts-route-helpers.ts:373`), so no route mapping code changes — but we lock it with a contract assertion in Step 9.

**Files:**
- Modify: `src/modules/broadcasts/application/use-cases/submit-broadcast.ts:13` (header comment), `:328-363` (guard block)
- Modify: `tests/unit/broadcasts/application/submit-broadcast.test.ts:500-518`
- Modify: `tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts:397-427`
- Modify: `src/app/api/admin/broadcasts/proxy-submit/route.ts:7-8` (header comment)
- Modify: `tests/contract/broadcasts/post-admin-broadcasts-proxy-submit.contract.test.ts` (add at-cap assertion)

**Interfaces:**
- Consumes: existing `submitBroadcast(deps, input)` and `SubmitBroadcastInput.actorRole: 'member' | 'admin_proxy'`.
- Produces: nothing new in signatures — behaviour change only (admin_proxy now subject to the same `computeQuotaCounter` cap check as `member`).

- [ ] **Step 1: Flip the submit-broadcast admin_proxy bypass test to assert enforcement (RED)**

In `tests/unit/broadcasts/application/submit-broadcast.test.ts`, replace the test at `:500-518` with an at-cap-blocked assertion:

```ts
  it('admin_proxy at full quota is BLOCKED (T-10 — admin cannot bypass the member cap per Q12)', async () => {
    const { audit, deps } = makeDeps({
      planCap: 6,
      used: 6,
      reserved: 0,
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'recipient@example.com' },
      ],
    });
    const result = await submitBroadcast(deps, {
      ...baseInput,
      actorRole: 'admin_proxy',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_quota_blocked');
      if (result.error.kind === 'broadcast_quota_blocked') {
        expect(result.error.cap).toBe(6);
      }
    }
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_quota_blocked'),
    ).toBeDefined();
  });
```

- [ ] **Step 2: Flip the two proxy-submit quota-bypass tests to assert enforcement (RED)**

In `tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts`, replace the two tests at `:399-412` and `:414-427` (under the `// ---- Quota bypass (Q12)` banner, which should be renamed to `// ---- Quota enforcement (T-10) ----`):

```ts
  // ---- Quota enforcement (T-10) ---------------------------------------

  it('admin proxy at full quota is BLOCKED → broadcast_quota_blocked (T-10)', async () => {
    const { deps, repo } = makeDeps({
      planCap: 6,
      used: 6,
      reserved: 0,
      primaryContact: 'm-target@example.com',
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    const result = await proxySubmitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_quota_blocked');
    }
    expect(repo.inserted).toHaveLength(0);
  });

  it('admin proxy over-cap is BLOCKED → broadcast_quota_blocked (T-10 invariant)', async () => {
    const { deps, repo } = makeDeps({
      planCap: 6,
      used: 8,
      reserved: 2,
      primaryContact: 'm-target@example.com',
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    const result = await proxySubmitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_quota_blocked');
    }
    expect(repo.inserted).toHaveLength(0);
  });
```

- [ ] **Step 3: Run the flipped tests — verify they FAIL (RED)**

Run: `pnpm vitest run tests/unit/broadcasts/application/submit-broadcast.test.ts tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts`
Expected: the 3 flipped tests FAIL (current code returns `ok: true` for admin_proxy at/over cap). Commit the red state.

```bash
git add tests/unit/broadcasts/application/submit-broadcast.test.ts tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts
git commit -m "test(broadcasts): RED — admin_proxy must enforce member quota cap (T-10)"
```

- [ ] **Step 4: Remove the admin_proxy quota-bypass guard (GREEN)**

In `src/modules/broadcasts/application/use-cases/submit-broadcast.ts`, the precondition-(b) block currently reads (lines 328-363):

```ts
  // ---- Precondition (b): quota -------------------------------------
  // admin_proxy bypasses quota per Q12 (admin emergency correction path)
  if (input.actorRole !== 'admin_proxy') {
    const quota = await computeQuotaCounter(
      {
        tenant: deps.tenant,
        plansBridge: deps.plansBridge,
        broadcastsRepo: deps.broadcastsRepo,
        clock: deps.clock,
      },
      { memberId: asMemberId(input.memberId) },
    );
    if (!quota.ok) {
      // Round-4 MED-D — counter internal error (DB blip) is NOT
      // "quota full". Returning fake `quota_blocked` collapses the
      // distinction and wrongly maps to 422 (user fault). Surface as
      // 500 server_error so ops dashboards can split rate-limited
      // submissions from infra-induced rejections.
      return err({
        kind: 'submit.server_error',
        message: `quota_counter_error: ${quota.error.kind}`,
      });
    }
    if (quota.value.counter.remaining === 0) {
      await emitReject(deps, input, 'broadcast_quota_blocked', {
        memberId: input.memberId,
        ...quota.value.counter,
      });
      return err({
        kind: 'broadcast_quota_blocked',
        used: quota.value.counter.used,
        reserved: quota.value.counter.reserved,
        cap: quota.value.counter.cap,
      });
    }
  }
```

Replace it with the unconditional form (guard removed, body dedented, comment corrected):

```ts
  // ---- Precondition (b): quota -------------------------------------
  // Enforced for ALL actor roles incl admin_proxy: Q12 says the
  // member's quota counts against them "regardless" — an admin
  // submitting on their behalf must NOT grant a free broadcast
  // (T-10 / security.md CHK005). There is no "emergency bypass" in Q12.
  const quota = await computeQuotaCounter(
    {
      tenant: deps.tenant,
      plansBridge: deps.plansBridge,
      broadcastsRepo: deps.broadcastsRepo,
      clock: deps.clock,
    },
    { memberId: asMemberId(input.memberId) },
  );
  if (!quota.ok) {
    // Round-4 MED-D — counter internal error (DB blip) is NOT
    // "quota full". Returning fake `quota_blocked` collapses the
    // distinction and wrongly maps to 422 (user fault). Surface as
    // 500 server_error so ops dashboards can split rate-limited
    // submissions from infra-induced rejections.
    return err({
      kind: 'submit.server_error',
      message: `quota_counter_error: ${quota.error.kind}`,
    });
  }
  if (quota.value.counter.remaining === 0) {
    await emitReject(deps, input, 'broadcast_quota_blocked', {
      memberId: input.memberId,
      ...quota.value.counter,
    });
    return err({
      kind: 'broadcast_quota_blocked',
      used: quota.value.counter.used,
      reserved: quota.value.counter.reserved,
      cap: quota.value.counter.cap,
    });
  }
```

- [ ] **Step 5: Fix the use-case header comment**

In `src/modules/broadcasts/application/use-cases/submit-broadcast.ts:13`, change:

```ts
 *   b. quota → broadcast_quota_blocked  (admin_proxy bypasses per Q12)
```
to:
```ts
 *   b. quota → broadcast_quota_blocked  (enforced for all actors incl admin_proxy — T-10)
```

- [ ] **Step 6: Run the flipped unit tests — verify GREEN**

Run: `pnpm vitest run tests/unit/broadcasts/application/submit-broadcast.test.ts tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts`
Expected: all PASS (including the 3 flipped tests). If any OTHER test in these files asserted the old bypass, update it the same way (assert enforcement) — there should be none beyond the 3 named.

- [ ] **Step 7: Confirm submit-broadcast branch coverage still 100%**

Run: `pnpm vitest run tests/unit/broadcasts/application/submit-broadcast.test.ts --coverage.enabled --coverage.include='src/modules/broadcasts/application/use-cases/submit-broadcast.ts'`
Expected: 100% branch on `submit-broadcast.ts`. The removed guard *reduced* branches (one fewer `if`), so existing member-path quota tests now also cover the (formerly admin-only-skipped) path. If a branch is newly uncovered, it will be the `admin_proxy` happy-path under cap — covered by the existing proxy success tests; add one only if coverage reports a gap.

- [ ] **Step 8: Fix the proxy route header comment**

In `src/app/api/admin/broadcasts/proxy-submit/route.ts:7-8`, change:

```ts
 * Authz: admin only (manager 403). Quota check is BYPASSED for
 * `actor_role='admin_proxy'` (Q12 emergency correction).
```
to:
```ts
 * Authz: admin only (manager 403). The proxied member's quota cap is
 * ENFORCED (T-10 / Q12 — the member never gets a free broadcast); an
 * at-cap proxy submit returns 422 `broadcast_quota_blocked`.
```

- [ ] **Step 9: Add a contract assertion that admin_proxy at-cap → 422 broadcast_quota_blocked**

In `tests/contract/broadcasts/post-admin-broadcasts-proxy-submit.contract.test.ts`, add a test that mocks the quota counter to report `remaining: 0` for the proxied member and asserts the route returns `422` with `error.code === 'broadcast_quota_blocked'`. Mirror the file's existing mock-wiring style (use the same `vi.mock` / `makeDeps` harness the other tests in this file use — read the file head to match its mocking pattern; the at-cap setup is `planCap` ≤ `used`). Keep the assertion minimal:

```ts
  it('admin_proxy at full member quota → 422 broadcast_quota_blocked (T-10)', async () => {
    // …arrange the proxied member at-cap via the file's existing deps mock…
    const res = await POST(makeRequest({ requestedByMemberId: MEMBER_ID, /* …valid body… */ }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe('broadcast_quota_blocked');
  });
```

- [ ] **Step 10: Run the contract suite — verify GREEN**

Run: `pnpm vitest run tests/contract/broadcasts/post-admin-broadcasts-proxy-submit.contract.test.ts`
Expected: all PASS including the new at-cap assertion.

- [ ] **Step 11: Typecheck + commit (GREEN)**

Run: `pnpm typecheck` (true check — if the dev server is running, the `.next/dev/types` masking caveat applies; if `tsc` aborts on `.next`, run via a temp tsconfig that excludes `.next`). Expected: 0 errors.

```bash
git add src/modules/broadcasts/application/use-cases/submit-broadcast.ts \
        src/app/api/admin/broadcasts/proxy-submit/route.ts \
        tests/unit/broadcasts/application/submit-broadcast.test.ts \
        tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts \
        tests/contract/broadcasts/post-admin-broadcasts-proxy-submit.contract.test.ts
git commit -m "fix(broadcasts): enforce member quota cap on admin_proxy submit (T-10)

Remove the precondition-(b) admin_proxy quota bypass in submit-broadcast.
Q12 says the member's quota counts against them regardless; an admin
submitting on their behalf must not grant a free broadcast (security.md
CHK005 / T-10). Rate-limit precondition (d) is unchanged. At-cap proxy
submit now returns 422 broadcast_quota_blocked.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2a: At-cap admin_proxy quota integration test (live Neon)

**Commit group 1 (continued).** Proves the T-10 fix end-to-end against real Postgres + RLS, not mocks.

**Files:**
- Create: `tests/integration/broadcasts/proxy-submit-quota-cap.integration.test.ts`

**Interfaces:**
- Consumes: `proxySubmitBroadcast` + `makeProxySubmitBroadcastDeps` (from the barrel — read-only import, already exported), the integration test-tenant helpers (`tests/integration/helpers/test-tenant.ts`), and whatever seed helpers the existing broadcasts integration tests use to create a member + plan with a known `eblast_per_year` cap and to insert sent broadcasts up to the cap.

- [ ] **Step 1: Read an existing broadcasts integration test to match harness/seed conventions**

Read: `tests/integration/broadcasts/` (pick the submit-broadcast quota integration test if present, else the nearest broadcasts integration test). Note how it (a) provisions a test tenant, (b) seeds a member + plan with a quota cap, (c) inserts broadcasts to consume quota, (d) constructs deps via `makeProxySubmitBroadcastDeps`/`makeSubmitBroadcastDeps`, (e) tears down. Reuse those helpers verbatim — do not invent new seed SQL.

- [ ] **Step 2: Write the at-cap integration test (RED until run against the fixed code — but code is already fixed, so it should pass)**

```ts
/**
 * DV-4 / T-10 — admin_proxy submit MUST honour the proxied member's
 * quota cap against live Neon (RLS-scoped). At-cap → broadcast_quota_blocked,
 * no broadcast row inserted.
 */
// imports + test-tenant harness per Step 1
it('admin_proxy at the member cap is blocked (no free broadcast)', async () => {
  // seed: member on a plan with eblast_per_year = N; insert N sent broadcasts
  // for that member so remaining = 0.
  const result = await proxySubmitBroadcast(deps, {
    proxiedMemberId: memberId,
    adminUserId: adminUserId,
    tenantDisplayName: 'Test Chamber',
    // Task 3 changes this field — see note below.
    memberDisplayName: 'Test Member Co',
    subject: 'Proxy at cap',
    bodySource: '<p>hi</p>',
    bodyHtml: '<p>hi</p>',
    segment: { kind: 'all_members' },
    scheduledFor: null,
    requestId: null,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.kind).toBe('broadcast_quota_blocked');
  // assert no broadcast row was inserted for this member after the call
});
```

> **Cross-task note:** Task 3 replaces the `memberDisplayName` field with a `memberLookup` discriminated input. When Task 3 lands, update this test's input to `memberLookup: { status: 'found', companyName: 'Test Member Co' }` (the Task 3 reviewer must confirm this integration test compiles).

- [ ] **Step 3: Run the integration test manually (pre-push gate is skipped for broadcasts)**

Run: `pnpm test:integration tests/integration/broadcasts/proxy-submit-quota-cap.integration.test.ts`
Expected: PASS (the Task 1 fix is already in). If the shared-Neon enum-drift failure (`broadcast_content_redacted`) appears in *unrelated* audit-parity tests, ignore it — it is not this test.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/broadcasts/proxy-submit-quota-cap.integration.test.ts
git commit -m "test(broadcasts): integration — admin_proxy honours member quota cap (T-10)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2b: Cross-tenant proxy isolation integration test (Principle I blocker)

**Commit group 1 (continued).** Review-Gate blocker per Constitution Principle I: an admin in tenant A proxy-submitting with a member id that belongs to tenant B must be rejected as not-found (RLS hides the row), never leak or write across tenants.

**Files:**
- Create: `tests/integration/broadcasts/proxy-submit-cross-tenant.integration.test.ts`

**Interfaces:**
- Consumes: same harness as Task 2a, but provisions **two** test tenants (A + B) — reuse the two-tenant pattern from an existing cross-tenant integration test (search `tests/integration/**` for `cross_tenant` / `cross-tenant`).

- [ ] **Step 1: Find the canonical two-tenant cross-tenant integration pattern**

Read the nearest existing `*cross-tenant*` integration test (e.g. under `tests/integration/broadcasts/` or `tests/integration/members/`). Mirror its two-tenant setup + the `runInTenant` context construction for tenant A while the member lives in tenant B.

- [ ] **Step 2: Write the cross-tenant proxy test**

```ts
/**
 * DV-4 / Principle I — admin in tenant A cannot proxy-submit for a
 * member that exists only in tenant B. RLS hides the row → the route's
 * findById misses → broadcast_member_not_found; nothing is written in
 * either tenant.
 */
it('admin in tenant A proxy-submitting a tenant-B member id → member_not_found, no cross-tenant write', async () => {
  // seed member in tenant B; build deps scoped to tenant A
  const result = await proxySubmitBroadcast(depsTenantA, {
    proxiedMemberId: tenantBMemberId,
    /* …rest of input (memberLookup status will be 'not_found' after Task 3
       because the route's tenant-A findById misses the tenant-B row)… */
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.kind).toBe('broadcast_member_not_found');
  // assert: zero broadcasts in tenant A AND tenant B for that member id
});
```

> **Cross-task note:** Before Task 3, the use-case itself probes via `memberExistsInTenant` (tenant-A-scoped) → `false` → `broadcast_member_not_found`. After Task 3, the route's tenant-A `findById` misses → `memberLookup: { status: 'not_found' }` → same result. Either way the assertion holds; the Task 3 implementer threads the input shape accordingly.

- [ ] **Step 3: Run + commit**

Run: `pnpm test:integration tests/integration/broadcasts/proxy-submit-cross-tenant.integration.test.ts` → PASS.

```bash
git add tests/integration/broadcasts/proxy-submit-cross-tenant.integration.test.ts
git commit -m "test(broadcasts): integration — proxy-submit cross-tenant isolation (Principle I)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: #18 read-dedup — single member read via discriminated `memberLookup` input

**Commit group 2.** Collapse the two member reads (route `findById` + use-case `memberExistsInTenant`) into one by passing the route's lookup outcome into the use-case. Preserve: member-not-found → 404, infra-throw → 500, DV-17 `companyName` → from-name. Do **not** touch the barrel.

**Files:**
- Modify: `src/modules/broadcasts/application/use-cases/proxy-submit-broadcast.ts`
- Modify: `src/app/api/admin/broadcasts/proxy-submit/route.ts:79-110`
- Modify: `tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts` (migrate existence tests + baseInput)
- Modify: `tests/integration/broadcasts/proxy-submit-quota-cap.integration.test.ts` + `…cross-tenant…` (update input shape per the Task 2 cross-task notes)

**Interfaces:**
- Produces (new exported type from the use-case module — **not** the barrel):
  ```ts
  export type ProxyMemberLookup =
    | { readonly status: 'found'; readonly companyName: string }
    | { readonly status: 'not_found' }
    | { readonly status: 'lookup_failed'; readonly message: string };
  ```
- Changes `ProxySubmitBroadcastInput`: **remove** `memberDisplayName: string`, **add** `memberLookup: ProxyMemberLookup`.
- The route imports `ProxyMemberLookup` directly: `import type { ProxyMemberLookup } from '@/modules/broadcasts/application/use-cases/proxy-submit-broadcast'`.

- [ ] **Step 1: Write the use-case unit tests for the discriminated input (RED)**

In `tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts`:
1. Update the shared `baseInput` to supply `memberLookup: { status: 'found', companyName: 'Test Member Co' }` and remove `memberDisplayName`.
2. Update `makeDeps` so it no longer needs to mock `memberExistsInTenant` for the existence decision (the use-case won't call it). Leave the rest of the bridge mock (recipient resolution, primary-contact, halt) intact.
3. Replace the existing existence tests (the ones that set `memberExistsInTenant` to return false / throw) with input-driven ones:

```ts
  // ---- Member lookup (provided by the route — #18 single-read) -------

  it('memberLookup.status="not_found" → broadcast_member_not_found, nothing inserted', async () => {
    const { deps, repo } = makeDeps({ primaryContact: 'm@example.com' });
    const result = await proxySubmitBroadcast(deps, {
      ...baseInput,
      memberLookup: { status: 'not_found' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast_member_not_found');
    expect(repo.inserted).toHaveLength(0);
  });

  it('memberLookup.status="lookup_failed" → submit.server_error (infra, maps to 500)', async () => {
    const { deps, repo } = makeDeps({ primaryContact: 'm@example.com' });
    const result = await proxySubmitBroadcast(deps, {
      ...baseInput,
      memberLookup: { status: 'lookup_failed', message: 'repo.unexpected' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('submit.server_error');
    expect(repo.inserted).toHaveLength(0);
  });

  it('memberLookup.status="found" threads companyName into the delegated submit (DV-17)', async () => {
    const { deps, repo } = makeDeps({
      planCap: 6,
      used: 0,
      reserved: 0,
      primaryContact: 'm-target@example.com',
      recipients: [{ memberId: 'm-other', primaryContactEmail: 'other@example.com' }],
    });
    const result = await proxySubmitBroadcast(deps, {
      ...baseInput,
      memberLookup: { status: 'found', companyName: 'Acme AB' },
    });
    expect(result.ok).toBe(true);
    expect(repo.inserted).toHaveLength(1);
    // from_name composed as "Acme AB via <tenant>" — assert via the inserted
    // row's fromName field per the repo mock's captured insert.
    expect(repo.inserted[0]?.fromName).toContain('Acme AB');
  });
```

(Match the exact field names the repo mock captures — read the file's `makeDeps` to confirm whether it exposes `inserted[].fromName` or similar; adjust the last assertion to the real captured field.)

- [ ] **Step 2: Run — verify FAIL (RED)**

Run: `pnpm vitest run tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts`
Expected: the new lookup tests FAIL to compile/pass (input field `memberLookup` not yet on the type; `memberDisplayName` removed). Commit red.

```bash
git add tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts
git commit -m "test(broadcasts): RED — proxy-submit consumes route-provided member lookup (#18)"
```

- [ ] **Step 3: Rewrite the use-case to consume `memberLookup` (GREEN)**

Replace the body of `src/modules/broadcasts/application/use-cases/proxy-submit-broadcast.ts` from the `ProxySubmitBroadcastError` type through the function. Key edits:

1. Add the `ProxyMemberLookup` export.
2. In `ProxySubmitBroadcastInput`: remove `memberDisplayName`, add `memberLookup: ProxyMemberLookup`.
3. Replace the `try { exists = await deps.membersBridge.memberExistsInTenant(...) }` block (lines 70-93) with a switch on `input.memberLookup.status`.
4. Update the header comment (lines 1-23) to state the route performs the single member read and passes the outcome in.

```ts
/**
 * T102 — `proxy-submit-broadcast.ts` Application use-case (F7 US2 / Q12).
 *
 * Admin-on-behalf-of-member submission. Composes `submitBroadcast`
 * with `actorRole='admin_proxy'`:
 *   - `requestedByMemberId` = proxied member id (whose quota is reserved
 *     and whose primary-contact email is reply-to)
 *   - `submittedByUserId`   = acting admin user id (for audit)
 *   - `actorRole`            = 'admin_proxy'
 *
 * #18 (single member read): the calling route already loads the proxied
 * member once (for the DV-17 `companyName` → from-name). It passes the
 * outcome in via `memberLookup` so this use-case does NOT issue a second
 * `memberExistsInTenant` probe. The route maps its single
 * `drizzleMemberRepo.findById` to:
 *   - found       → { status: 'found', companyName }
 *   - repo.not_found → { status: 'not_found' }  → broadcast_member_not_found (404)
 *   - other error    → { status: 'lookup_failed', message } → submit.server_error (500)
 * preserving the not-found(404)/infra-throw(500) distinction without a
 * second round-trip.
 *
 * The proxied member's quota cap IS enforced inside `submitBroadcast`
 * (T-10); admin_proxy gets no free broadcast.
 *
 * The acting admin path runs `submitBroadcast`'s rate-limit precondition
 * (d) unchanged. Halt-state precondition (FR-002 k) STILL applies —
 * admin cannot bypass a member's halt flag (R3-NEW-1).
 */
import type { Result } from '@/lib/result';
import {
  submitBroadcast,
  type SubmitBroadcastDeps,
  type SubmitBroadcastError,
  type SubmitBroadcastInput,
  type SubmitBroadcastOutput,
} from './submit-broadcast';
import type { RecipientSegment } from '../../domain/recipient-segment';

/**
 * Outcome of the route's single member read, threaded into the use-case
 * so it need not re-probe (#18). `companyName` only exists in the `found`
 * arm — the type forbids reading it otherwise.
 */
export type ProxyMemberLookup =
  | { readonly status: 'found'; readonly companyName: string }
  | { readonly status: 'not_found' }
  | { readonly status: 'lookup_failed'; readonly message: string };

export type ProxySubmitBroadcastError =
  | SubmitBroadcastError
  | { readonly kind: 'broadcast_member_not_found'; readonly memberId: string };

export type ProxySubmitBroadcastDeps = SubmitBroadcastDeps;

export interface ProxySubmitBroadcastInput {
  readonly proxiedMemberId: string;
  readonly adminUserId: string;
  readonly tenantDisplayName: string;
  /**
   * #18 — the proxied member read performed once by the route. The
   * `found` arm carries DV-17 `companyName` (F3) used by the delegated
   * `submitBroadcast` to compose `from_name` as
   * "<companyName> via <tenantDisplayName>" (data-model.md:59).
   */
  readonly memberLookup: ProxyMemberLookup;
  readonly subject: string;
  readonly bodySource: string;
  readonly bodyHtml: string;
  readonly segment: RecipientSegment;
  readonly scheduledFor: Date | null;
  readonly requestId: string | null;
}

export type ProxySubmitBroadcastOutput = SubmitBroadcastOutput;

export async function proxySubmitBroadcast(
  deps: ProxySubmitBroadcastDeps,
  input: ProxySubmitBroadcastInput,
): Promise<Result<ProxySubmitBroadcastOutput, ProxySubmitBroadcastError>> {
  // #18 — consume the route's single member read instead of re-probing.
  switch (input.memberLookup.status) {
    case 'lookup_failed':
      // infra failure during the read → 500, never a misleading 422/404.
      return {
        ok: false,
        error: {
          kind: 'submit.server_error',
          message: `member_lookup_failed: ${input.memberLookup.message}`,
        },
      } as Result<ProxySubmitBroadcastOutput, ProxySubmitBroadcastError>;
    case 'not_found':
      return {
        ok: false,
        error: {
          kind: 'broadcast_member_not_found',
          memberId: input.proxiedMemberId,
        },
      } as Result<ProxySubmitBroadcastOutput, ProxySubmitBroadcastError>;
    case 'found':
      break;
  }

  const submitInput: SubmitBroadcastInput = {
    memberId: input.proxiedMemberId,
    submittedByUserId: input.adminUserId,
    actorRole: 'admin_proxy',
    tenantDisplayName: input.tenantDisplayName,
    memberDisplayName: input.memberLookup.companyName,
    subject: input.subject,
    bodySource: input.bodySource,
    bodyHtml: input.bodyHtml,
    segment: input.segment,
    scheduledFor: input.scheduledFor,
    requestId: input.requestId,
  };

  const result = await submitBroadcast(deps, submitInput);
  return result as Result<ProxySubmitBroadcastOutput, ProxySubmitBroadcastError>;
}
```

- [ ] **Step 4: Rewrite the route to map `findById` → `memberLookup` (GREEN)**

In `src/app/api/admin/broadcasts/proxy-submit/route.ts`:

1. Add the import: `import type { ProxyMemberLookup } from '@/modules/broadcasts/application/use-cases/proxy-submit-broadcast';`
2. Replace the DV-17 lookup block (lines 79-110) so the single `findById` produces a `memberLookup`, fed into the use-case. Use an explicit `if/else` (no nested ternary — presentation rule):

```ts
  try {
    // #18 + DV-17 — single member read. Resolve the proxied member once
    // here (the admin context loads no member) and pass the outcome into
    // the use-case so it does not re-probe. Distinguishes:
    //   ok            → found, companyName → from-name "<member> via <tenant>"
    //   repo.not_found → not_found → broadcast_member_not_found (404)
    //   other error    → lookup_failed → submit.server_error (500)
    const memberLookupResult = await drizzleMemberRepo.findById(
      tenantCtx,
      asMemberId(parsed.data.requestedByMemberId),
    );
    let memberLookup: ProxyMemberLookup;
    if (memberLookupResult.ok) {
      memberLookup = {
        status: 'found',
        companyName: memberLookupResult.value.companyName,
      };
    } else if (memberLookupResult.error.code === 'repo.not_found') {
      memberLookup = { status: 'not_found' };
    } else {
      memberLookup = {
        status: 'lookup_failed',
        message: memberLookupResult.error.code,
      };
    }

    const result = await proxySubmitBroadcast(deps, {
      proxiedMemberId: parsed.data.requestedByMemberId,
      adminUserId: ctx.current.user.id,
      tenantDisplayName,
      memberLookup,
      subject: parsed.data.subject,
      bodySource: parsed.data.bodySource,
      bodyHtml: parsed.data.bodyHtml,
      segment: parsed.data.segment,
      scheduledFor:
        parsed.data.scheduledFor != null
          ? new Date(parsed.data.scheduledFor)
          : null,
      requestId: ctx.requestId,
    });

    if (!result.ok) {
      return mapProxySubmitError(result.error, correlationId);
    }
    // …unchanged success NextResponse.json(...)…
  } catch (e) {
    // …unchanged 500 handler…
  }
```

(Confirm `memberLookupResult.error.code` is the field name — the F3 `RepoError` is `{ code: 'repo.not_found' }` / `unexpected(e)` per `drizzle-member-repo.ts:249-252`.)

- [ ] **Step 5: Run the use-case unit tests — verify GREEN**

Run: `pnpm vitest run tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts`
Expected: all PASS (including the migrated lookup tests + the Task 1 quota-enforcement tests).

- [ ] **Step 6: Keep the contract tests green (route behaviour preserved)**

Run: `pnpm vitest run tests/contract/broadcasts/post-admin-broadcasts-proxy-submit.contract.test.ts`
Expected: all PASS. The named cases must still hold: 404 `broadcast_member_not_found` (was line ~218), 500 `submit.server_error`/thrown (was ~292/302), DV-17 `companyName` resolution (was ~138), and the Task 1 at-cap 422. The contract file mocks `drizzleMemberRepo.findById` — confirm its mock now drives the not-found case via `{ ok: false, error: { code: 'repo.not_found' } }` and the infra case via `{ ok: false, error: { code: 'repo.unexpected', ... } }` (or a thrown error caught by the route's outer try → 500). If the file previously made the use-case's `memberExistsInTenant` decide not-found, repoint that mock to the `findById` result; update only the mock wiring, not the assertions.

- [ ] **Step 7: Update the Task 2 integration tests to the new input shape**

Edit `tests/integration/broadcasts/proxy-submit-quota-cap.integration.test.ts` and `…proxy-submit-cross-tenant…` to pass `memberLookup: { status: 'found', companyName: '<seeded company>' }` (quota-cap test) / drive the cross-tenant test through the route OR set `memberLookup: { status: 'not_found' }` (since tenant-A `findById` misses the tenant-B row). Re-run both:
Run: `pnpm test:integration tests/integration/broadcasts/proxy-submit-quota-cap.integration.test.ts tests/integration/broadcasts/proxy-submit-cross-tenant.integration.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck + commit (GREEN)**

Run: `pnpm typecheck` → 0 errors. Confirm no other caller constructs `ProxySubmitBroadcastInput` (grep `memberDisplayName` under `src/` + `tests/` → only the proxy use-case internals + tests should reference it now).

```bash
git add src/modules/broadcasts/application/use-cases/proxy-submit-broadcast.ts \
        src/app/api/admin/broadcasts/proxy-submit/route.ts \
        tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts \
        tests/integration/broadcasts/proxy-submit-quota-cap.integration.test.ts \
        tests/integration/broadcasts/proxy-submit-cross-tenant.integration.test.ts
git commit -m "refactor(broadcasts): dedup proxy-submit member read via route-provided lookup (#18)

The route already loads the proxied member once (DV-17 companyName). Pass
the lookup outcome into proxySubmitBroadcast as a discriminated input so
the use-case no longer issues a second memberExistsInTenant probe.
Preserves not-found→404 and infra-failure→500. Barrel untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Export `buildSegmentPayload` + new `member-picker.tsx` (+ unit tests)

**Commit group 3 (UI) — part 1.** Shared building blocks for the admin compose form.

**Files:**
- Modify: `src/components/broadcast/compose-form.tsx:86` (add `export` to `buildSegmentPayload`)
- Create: `src/components/broadcast/member-picker.tsx`
- Create: `tests/unit/broadcast/build-segment-payload.test.ts`
- Create: `tests/unit/broadcast/member-picker.test.tsx`

**Interfaces:**
- Produces: `export function buildSegmentPayload(segment: SegmentPickerValue, customLines: ReadonlyArray<string>): RecipientSegment` (existing impl, now exported).
- Produces:
  ```ts
  export interface MemberPickerOption { readonly memberId: string; readonly companyName: string; readonly primaryContactName: string | null; }
  export interface MemberPickerProps {
    readonly value: MemberPickerOption | null;
    readonly onSelect: (m: MemberPickerOption | null) => void;
    readonly label: string;
    readonly placeholder: string;
    readonly searchFailedText: string;
    readonly emptyText: string;
    readonly disabled?: boolean;
    readonly triggerRef?: React.Ref<HTMLButtonElement>;
  }
  export function MemberPicker(props: MemberPickerProps): React.ReactElement;
  ```

- [ ] **Step 1: Export `buildSegmentPayload`**

In `src/components/broadcast/compose-form.tsx:86`, change `function buildSegmentPayload(` to `export function buildSegmentPayload(`. No other change. Confirm `SegmentPickerValue` and the return type are importable (they are already declared/imported in this file — if `RecipientSegment` is the return type, ensure it's exported or re-export the inferred type).

- [ ] **Step 2: Write the `buildSegmentPayload` unit test (RED)**

`tests/unit/broadcast/build-segment-payload.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSegmentPayload } from '@/components/broadcast/compose-form';

describe('buildSegmentPayload', () => {
  it('maps all_members', () => {
    expect(buildSegmentPayload({ kind: 'all_members' }, [])).toEqual({ kind: 'all_members' });
  });
  it('maps tier with tier codes', () => {
    expect(buildSegmentPayload({ kind: 'tier', tierCodes: ['GOLD'] }, [])).toEqual({
      kind: 'tier',
      tierCodes: ['GOLD'],
    });
  });
  it('maps event_attendees_last_90d', () => {
    expect(buildSegmentPayload({ kind: 'event_attendees_last_90d' }, [])).toEqual({
      kind: 'event_attendees_last_90d',
    });
  });
  it('maps custom from custom lines', () => {
    expect(buildSegmentPayload({ kind: 'custom' }, ['a@x.com', 'b@x.com'])).toEqual({
      kind: 'custom',
      emails: ['a@x.com', 'b@x.com'],
    });
  });
});
```

> Read `compose-form.tsx:86-130` first and make the expected values match the **actual** mapping (the `switch` arms + how `custom` reads `customLines`). Adjust the cases to the real shapes — do not assert a shape the function doesn't produce.

- [ ] **Step 3: Run — RED, then GREEN after the export**

Run: `pnpm vitest run tests/unit/broadcast/build-segment-payload.test.ts`
Expected: PASS once the `export` from Step 1 is in (the function already works). If RED only because of the import, the export fixes it.

- [ ] **Step 4: Write `member-picker.tsx` (mirror the relink cmdk search)**

Create `src/components/broadcast/member-picker.tsx`, mirroring the search effect from `src/components/events/relink-registration-dialog.tsx:180-289` (the `useDeferredValue` + `fetchSeqRef` + `AbortController` + `SearchResponseSchema` pattern), adapted to a standalone Popover+Command picker (not a dialog). Key points:
- Use `cmdk` via the shadcn `Command`/`CommandInput`/`CommandList`/`CommandItem` wrappers (same imports the relink dialog uses) inside a `Popover` triggered by a button showing the selected company (or `placeholder`).
- Fetch `\`/api/admin/members/search?q=${encodeURIComponent(q)}&limit=10\`` with `Accept: application/json`, validate with a local `zod` schema matching the route's `{ items: [{ memberId, companyName, primaryContactName | null }] }` response (route at `src/app/api/admin/members/search/route.ts:86-94`).
- Race-guard with a `fetchSeqRef` incrementing counter; ignore stale responses; swallow `AbortError`; surface non-abort failures as `searchFailedText` (distinct from `emptyText`); `console.error` on real failure (E2E visibility).
- On `CommandItem` select, call `onSelect({ memberId, companyName, primaryContactName })` and close the popover.
- Forward `triggerRef` to the trigger button (so the compose form can focus it on `broadcast_member_not_found`).
- This is a **copy-adapt**, not an import — do not refactor or import internals of the relink dialog.

```tsx
'use client';

import { useEffect, useId, useRef, useState, useDeferredValue } from 'react';
import { z } from 'zod';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface MemberPickerOption {
  readonly memberId: string;
  readonly companyName: string;
  readonly primaryContactName: string | null;
}

const SearchResponseSchema = z.object({
  items: z.array(
    z.object({
      memberId: z.string(),
      companyName: z.string(),
      primaryContactName: z.string().nullable(),
    }),
  ),
});

export interface MemberPickerProps {
  readonly value: MemberPickerOption | null;
  readonly onSelect: (m: MemberPickerOption | null) => void;
  readonly label: string;
  readonly placeholder: string;
  readonly searchFailedText: string;
  readonly emptyText: string;
  readonly disabled?: boolean;
  readonly triggerRef?: React.Ref<HTMLButtonElement>;
}

export function MemberPicker({
  value,
  onSelect,
  label,
  placeholder,
  searchFailedText,
  emptyText,
  disabled,
  triggerRef,
}: MemberPickerProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<readonly MemberPickerOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const deferredSearch = useDeferredValue(search);
  const trimmedQuery = deferredSearch.trim();
  const fetchSeqRef = useRef(0);
  const labelId = useId();

  /* eslint-disable react-hooks/set-state-in-effect --
   * Legitimate data-fetching effect mirroring relink-registration-dialog.tsx:203-271
   * (cancellable fetch; spinner must flip synchronously on query change). */
  useEffect(() => {
    if (!open || trimmedQuery === '') return;
    const controller = new AbortController();
    fetchSeqRef.current += 1;
    const mySeq = fetchSeqRef.current;
    setSearching(true);
    setSearchError(false);
    void fetch(
      `/api/admin/members/search?q=${encodeURIComponent(trimmedQuery)}&limit=10`,
      { signal: controller.signal, headers: { Accept: 'application/json' } },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`member-search responded ${res.status}`);
        const parsed = SearchResponseSchema.safeParse(await res.json());
        if (!parsed.success) throw new Error('member-search response shape invalid');
        return parsed.data;
      })
      .then((data) => {
        if (mySeq !== fetchSeqRef.current) return;
        setResults(data.items);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (mySeq !== fetchSeqRef.current) return;
        console.error('member-search fetch failed', err);
        setResults([]);
        setSearchError(true);
      })
      .finally(() => {
        if (mySeq !== fetchSeqRef.current) return;
        setSearching(false);
      });
    return () => controller.abort();
  }, [trimmedQuery, open]);

  useEffect(() => {
    if (!open) {
      setSearch('');
      setResults([]);
      setSearching(false);
      setSearchError(false);
    }
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const emptyMessage = searchError ? searchFailedText : emptyText;

  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium">
        {label}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-labelledby={labelId}
            disabled={disabled}
            className="h-9 w-full justify-between font-normal"
          >
            <span className={cn(!value && 'text-muted-foreground')}>
              {value ? value.companyName : placeholder}
            </span>
            <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder={placeholder}
            />
            <CommandList>
              {!searching && <CommandEmpty>{emptyMessage}</CommandEmpty>}
              <CommandGroup>
                {results.map((m) => (
                  <CommandItem
                    key={m.memberId}
                    value={m.memberId}
                    onSelect={() => {
                      onSelect(m);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        'mr-2 size-4',
                        value?.memberId === m.memberId ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="flex flex-col">
                      <span>{m.companyName}</span>
                      {m.primaryContactName && (
                        <span className="text-xs text-muted-foreground">
                          {m.primaryContactName}
                        </span>
                      )}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
```

> Confirm the exact import paths for `Command*` and `Popover*` against an existing consumer (the relink dialog + any palette component) — match whatever this repo exports (`@/components/ui/command`, `@/components/ui/popover`). If the shadcn `cmdk` wrapper file name differs, use the repo's actual path.

- [ ] **Step 5: Write the member-picker unit test (jsdom-safe — no popover-open interaction)**

`tests/unit/broadcast/member-picker.test.tsx` — assert the trigger renders the placeholder when no value and the company when a value is set; assert `triggerRef` resolves to the button. Do **not** open the Popover (Base UI/cmdk popovers can deadlock under jsdom — mirror the DV-6 guard-test discipline). Mock `next/navigation` + `fetch` is unnecessary because the effect only fires when `open` is true.

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { createRef } from 'react';
import { MemberPicker } from '@/components/broadcast/member-picker';

afterEach(() => cleanup());

describe('MemberPicker (closed-state guard)', () => {
  const baseProps = {
    onSelect: vi.fn(),
    label: 'Member',
    placeholder: 'Search by company name…',
    searchFailedText: 'Search failed',
    emptyText: 'No members',
  };

  it('shows the placeholder when no member is selected', () => {
    render(<MemberPicker {...baseProps} value={null} />);
    expect(screen.getByText('Search by company name…')).toBeInTheDocument();
  });

  it('shows the selected company name', () => {
    render(
      <MemberPicker
        {...baseProps}
        value={{ memberId: 'm-1', companyName: 'Acme AB', primaryContactName: 'Jo' }}
      />,
    );
    expect(screen.getByText('Acme AB')).toBeInTheDocument();
  });

  it('forwards triggerRef to the trigger button', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<MemberPicker {...baseProps} value={null} triggerRef={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});
```

- [ ] **Step 6: Run picker + payload unit tests — GREEN**

Run: `pnpm vitest run tests/unit/broadcast/member-picker.test.tsx tests/unit/broadcast/build-segment-payload.test.ts`
Expected: PASS.

- [ ] **Step 7: Lint + typecheck + commit**

Run: `pnpm lint && pnpm typecheck` (full lint — the React-Compiler memoization rules catch issues unit/typecheck miss). Expected: 0/0.

```bash
git add src/components/broadcast/compose-form.tsx \
        src/components/broadcast/member-picker.tsx \
        tests/unit/broadcast/build-segment-payload.test.ts \
        tests/unit/broadcast/member-picker.test.tsx
git commit -m "feat(broadcasts): admin member-picker + export buildSegmentPayload (DV-4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `proxy-compose-form.tsx` + `/admin/broadcasts/new` page + entry button + i18n

**Commit group 3 (UI) — part 2.** The admin compose surface and its route.

**Files:**
- Create: `src/components/broadcast/proxy-compose-form.tsx`
- Create: `src/app/(staff)/admin/broadcasts/new/page.tsx`
- Modify: `src/app/(staff)/admin/broadcasts/page.tsx` (entry button)
- Modify: `src/i18n/messages/{en,th,sv}.json` (new keys)

**Interfaces:**
- Consumes: `MemberPicker` + `MemberPickerOption` (Task 4), `buildSegmentPayload` (Task 4), and the existing sub-components `TiptapEditor`, `SegmentPicker`, `SchedulePicker`, `PreviewPane`, `SubmitButton` (read each component's props before wiring — match exactly).
- POSTs JSON to `/api/admin/broadcasts/proxy-submit` with body `{ requestedByMemberId, subject, bodyHtml, bodySource, segment, scheduledFor }` (matches `ProxySubmitBodySchema` at `route.ts:42-52`).

- [ ] **Step 1: Add the i18n keys (en canonical, then th + sv)**

Add under `admin.broadcasts.proxySubmitDialog` in all three locale files (extend the existing object — do not rename existing keys). The page reuses the existing `title`/`description`/field-label keys; these are the **net-new** keys:

`src/i18n/messages/en.json` → `admin.broadcasts.proxySubmitDialog`:
```json
      "pageSubtitle": "Compose and queue a broadcast for review using this member's e-blast quota.",
      "selfExclusionNotice": "{company} won't receive this broadcast — members are excluded from their own e-blasts.",
      "memberNotFoundError": "That member no longer exists. Pick another member.",
      "quotaBlockedError": "{company} has used all their e-blasts for this period.",
      "notInPlanError": "{company}'s plan doesn't include E-Blast.",
      "submitErrorToast": "Couldn't submit the broadcast. Please try again.",
      "successToast": "Broadcast queued for review on behalf of {company}."
```

Also add the entry-button label at `admin.broadcasts` (sibling of `proxySubmitDialog`):
```json
    "proxySubmitButton": "Submit on behalf of member",
```

`src/i18n/messages/th.json` → same keys:
```json
      "pageSubtitle": "เขียนและส่ง E-Blast เข้าคิวตรวจสอบโดยใช้โควตา E-Blast ของสมาชิกรายนี้",
      "selfExclusionNotice": "{company} จะไม่ได้รับ E-Blast ฉบับนี้ — สมาชิกจะถูกยกเว้นจาก E-Blast ของตนเอง",
      "memberNotFoundError": "ไม่พบสมาชิกรายนี้แล้ว กรุณาเลือกสมาชิกรายอื่น",
      "quotaBlockedError": "{company} ใช้โควตา E-Blast ของช่วงเวลานี้ครบแล้ว",
      "notInPlanError": "แพ็กเกจของ {company} ไม่รวมสิทธิ์ E-Blast",
      "submitErrorToast": "ส่ง E-Blast ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
      "successToast": "ส่ง E-Blast เข้าคิวตรวจสอบแทน {company} แล้ว"
```
and `admin.broadcasts.proxySubmitButton`: `"ส่งแทนสมาชิก"`.

`src/i18n/messages/sv.json` → same keys:
```json
      "pageSubtitle": "Skapa och kölägg ett utskick för granskning med den här medlemmens e-utskickskvot.",
      "selfExclusionNotice": "{company} får inte detta utskick — medlemmar exkluderas från sina egna utskick.",
      "memberNotFoundError": "Medlemmen finns inte längre. Välj en annan medlem.",
      "quotaBlockedError": "{company} har använt alla sina utskick för den här perioden.",
      "notInPlanError": "{company}s paket inkluderar inte E-utskick.",
      "submitErrorToast": "Det gick inte att skicka utskicket. Försök igen.",
      "successToast": "Utskicket har köalts för granskning å {company}:s vägnar."
```
and `admin.broadcasts.proxySubmitButton`: `"Skicka in å medlems vägnar"`.

> The `i18n-translation-reviewer` agent validates th/sv naturalness in the final review. ICU `{company}` is interpolated via `t('…', { company })`.

- [ ] **Step 2: Verify i18n parity**

Run: `pnpm check:i18n`
Expected: OK (no missing en keys; th/sv present).

- [ ] **Step 3: Read the sub-component props before wiring**

Read the prop interfaces of `TiptapEditor`, `SegmentPicker`, `SchedulePicker`, `PreviewPane`, `SubmitButton`, and how `compose-form.tsx` wires them (state, handlers, the `SegmentPickerValue` + `customLines` shape feeding `buildSegmentPayload`). The proxy form mirrors this wiring minus quota display, save-draft, and template-picker.

- [ ] **Step 4: Write `proxy-compose-form.tsx` (thin admin orchestrator)**

Create `src/components/broadcast/proxy-compose-form.tsx`. Responsibilities:
- Client component (`'use client'`).
- State: selected `MemberPickerOption | null`, `subject`, `bodyHtml`, `segment` (`SegmentPickerValue`), `customLines`, `scheduledFor`, `submitting`.
- Render order: `MemberPicker` → (when a member is selected) `selfExclusionNotice` with `{company: member.companyName}` → `SegmentPicker` → subject input → `TiptapEditor` → `SchedulePicker` → `PreviewPane` → `SubmitButton`.
- Submit disabled until a member is selected + subject non-empty + body non-empty (reuse the validation shape from `compose-form.tsx`).
- On submit: POST to `/api/admin/broadcasts/proxy-submit` with `{ requestedByMemberId: member.memberId, subject, bodyHtml, bodySource: bodyHtml, segment: buildSegmentPayload(segment, customLines), scheduledFor }`.
- Define an `ERROR_CODE_FIELD`/handler map (own to this form), mirroring `compose-form.tsx`'s `ERROR_CODE_FIELD` pattern but adding the proxy-specific codes:
  - `broadcast_member_not_found` (404) → set an inline error under the picker (`memberNotFoundError`) and focus the picker trigger via a `triggerRef`.
  - `broadcast_quota_blocked` (422) → toast `quotaBlockedError` with `{company}`.
  - `broadcast_not_in_plan` (422) → toast `notInPlanError` with `{company}`.
  - `broadcast_subject_too_long` → subject field; `broadcast_body_too_large` / `broadcast_body_unsafe_html` → body field; `broadcast_empty_segment_blocked` / `broadcast_audience_too_large` → segment field (reuse compose-form field mapping).
  - `broadcast_member_missing_primary_contact_email`, `broadcast_member_halted_pending_review`, `broadcast_rate_limit_exceeded`, `internal_error`, and any unmapped code → generic `submitErrorToast`.
- On success: toast `successToast` with `{company}`, then `router.push('/admin/broadcasts')`.
- Use `sonner` `toast` + `next-intl` `useTranslations('admin.broadcasts.proxySubmitDialog')` + `next/navigation` `useRouter`.

```tsx
'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MemberPicker, type MemberPickerOption } from './member-picker';
import { buildSegmentPayload } from './compose-form';
// import TiptapEditor, SegmentPicker, SchedulePicker, PreviewPane, SubmitButton,
// and the SegmentPickerValue type from their real paths (confirm in Step 3).

// Map a route error code to how the form reacts. Field codes set inline
// errors; the rest toast. broadcast_member_not_found refocuses the picker.
type ProxyErrorHandling =
  | { readonly kind: 'picker' }
  | { readonly kind: 'field'; readonly field: 'subject' | 'body' | 'segment' }
  | { readonly kind: 'toast'; readonly key: 'quotaBlockedError' | 'notInPlanError' | 'submitErrorToast' };

const ERROR_HANDLING: Record<string, ProxyErrorHandling> = {
  broadcast_member_not_found: { kind: 'picker' },
  broadcast_quota_blocked: { kind: 'toast', key: 'quotaBlockedError' },
  broadcast_not_in_plan: { kind: 'toast', key: 'notInPlanError' },
  broadcast_subject_too_long: { kind: 'field', field: 'subject' },
  broadcast_body_too_large: { kind: 'field', field: 'body' },
  broadcast_body_unsafe_html: { kind: 'field', field: 'body' },
  broadcast_empty_segment_blocked: { kind: 'field', field: 'segment' },
  broadcast_audience_too_large: { kind: 'field', field: 'segment' },
};

export function ProxyComposeForm(): React.ReactElement {
  const t = useTranslations('admin.broadcasts.proxySubmitDialog');
  const router = useRouter();
  const pickerRef = useRef<HTMLButtonElement>(null);
  const [member, setMember] = useState<MemberPickerOption | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  // segment + customLines + scheduledFor state mirrors compose-form.tsx
  const [submitting, setSubmitting] = useState(false);

  // …field state + handlers per Step 3…

  async function handleSubmit(): Promise<void> {
    if (!member) {
      setMemberError(t('memberNotFoundError'));
      pickerRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setMemberError(null);
    try {
      const res = await fetch('/api/admin/broadcasts/proxy-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestedByMemberId: member.memberId,
          subject,
          bodyHtml,
          bodySource: bodyHtml,
          segment: buildSegmentPayload(/* segment */, /* customLines */),
          scheduledFor: /* scheduledFor ISO or null */ null,
        }),
      });
      if (res.ok) {
        toast.success(t('successToast', { company: member.companyName }));
        router.push('/admin/broadcasts');
        return;
      }
      const json: unknown = await res.json().catch(() => null);
      const code =
        typeof json === 'object' && json && 'error' in json &&
        typeof (json as { error?: { code?: unknown } }).error?.code === 'string'
          ? (json as { error: { code: string } }).error.code
          : 'internal_error';
      const handling = ERROR_HANDLING[code] ?? { kind: 'toast', key: 'submitErrorToast' };
      switch (handling.kind) {
        case 'picker':
          setMemberError(t('memberNotFoundError'));
          pickerRef.current?.focus();
          break;
        case 'field':
          // set the matching inline field error (reuse compose-form field-error state)
          break;
        case 'toast':
          toast.error(t(handling.key, { company: member.companyName }));
          break;
      }
    } catch {
      toast.error(t('submitErrorToast', { company: member.companyName }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <MemberPicker
        value={member}
        onSelect={(m) => { setMember(m); setMemberError(null); }}
        label={t('memberLabel')}
        placeholder={t('memberPlaceholder')}
        searchFailedText={/* a reused 'search failed' copy */ ''}
        emptyText={/* a reused 'no members' copy */ ''}
        triggerRef={pickerRef}
      />
      {memberError && <p role="alert" className="text-sm text-destructive">{memberError}</p>}
      {member && (
        <p className="text-sm text-muted-foreground">
          {t('selfExclusionNotice', { company: member.companyName })}
        </p>
      )}
      {/* SegmentPicker, subject input, TiptapEditor, SchedulePicker, PreviewPane */}
      {/* SubmitButton: onClick=handleSubmit, disabled = submitting || !member || !subject.trim() || !bodyHtml.trim() */}
    </div>
  );
}
```

> Fill the `/* … */` placeholders against the real sub-component props from Step 3. For `searchFailedText`/`emptyText`, reuse existing copy if the relink dialog already has suitable keys; otherwise add `searchFailed`/`noResults` to the `proxySubmitDialog` namespace in all 3 locales (Step 1) rather than hardcoding. The `i18n` Step must cover any key this form references.

- [ ] **Step 5: Create the admin page `/admin/broadcasts/new`**

Create `src/app/(staff)/admin/broadcasts/new/page.tsx` — a server component that enforces admin-only access and renders the form inside the standard container (mirror the layout of `src/app/(member)/portal/broadcasts/new/page.tsx` but admin-gated and without quota/template logic):

```tsx
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { ProxyComposeForm } from '@/components/broadcast/proxy-compose-form';
import { requireSession } from '@/lib/auth-session';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.broadcasts.proxySubmitDialog');
  return { title: t('title') };
}

export default async function AdminProxyComposePage(): Promise<React.ReactElement> {
  // Admin-only (manager/member must not reach the proxy compose surface).
  // Use the same role guard the other admin-only pages use — confirm the
  // exact requireSession signature/role-arg by reading a sibling admin page.
  await requireSession('admin');
  const t = await getTranslations('admin.broadcasts.proxySubmitDialog');
  return (
    <FormContainer>
      <PageHeader title={t('title')} subtitle={t('pageSubtitle')} />
      <ProxyComposeForm />
    </FormContainer>
  );
}
```

> **Confirm the admin role guard.** `requireSession('member')` is what the portal page uses; the admin equivalent may be `requireSession('admin')`, `requireAdminSession()`, or a guard that admits admin only (not manager). Read an existing admin-only page under `src/app/(staff)/admin/**` (e.g. a settings or members write page) and use the identical guard so manager is rejected. The route handler already enforces admin-only at the API; this page guard prevents manager from *seeing* the compose surface. `check:layout` requires a container — `FormContainer` satisfies it. Do not add a `loading.tsx` unless a sibling pattern requires it.

- [ ] **Step 6: Add the entry button on `/admin/broadcasts`**

In `src/app/(staff)/admin/broadcasts/page.tsx`, add a header action linking to `/admin/broadcasts/new`, labelled `admin.broadcasts.proxySubmitButton`. Read the page first to match how it renders its header/actions (likely a `PageHeader` with an actions slot or a button row). The button must be visible to admin; if the page is shared with manager, gate the button so manager does not see it (mirror how other admin-only actions are conditionally rendered on that page — e.g. a `role`/`canWrite` prop already threaded through). Use a `next/link` `Button asChild` (h-9, per the design-system 36px standard):

```tsx
import Link from 'next/link';
import { Button } from '@/components/ui/button';
// in the header actions, admin-only:
<Button asChild className="h-9">
  <Link href="/admin/broadcasts/new">{t('proxySubmitButton')}</Link>
</Button>
```

- [ ] **Step 7: Lint + typecheck + check:layout**

Run: `pnpm lint && pnpm typecheck && pnpm check:layout`
Expected: 0/0, layout OK.

- [ ] **Step 8: Commit**

```bash
git add src/components/broadcast/proxy-compose-form.tsx \
        "src/app/(staff)/admin/broadcasts/new/page.tsx" \
        "src/app/(staff)/admin/broadcasts/page.tsx" \
        src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json
git commit -m "feat(broadcasts): admin proxy-submit compose page + entry button (DV-4)

New /admin/broadcasts/new (admin-only) reuses the compose sub-components
and the new member-picker to submit a broadcast on a member's behalf via
the existing proxy-submit route. Adds Q16 self-exclusion microcopy and
proxy error/success copy (en/th/sv).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: E2E — AS9 full proxy-submit happy path + RBAC boundaries

**Commit group 3 (UI) — part 3.** One spec file covering: AS9 dual-actor full submit (DB-verified), manager-403 (page + route), member-403, and admin-only entry-button visibility.

**Files:**
- Create: `tests/e2e/admin-proxy-submit.spec.ts`

**Interfaces:**
- Consumes: `signInAsAdmin` (`tests/e2e/helpers/admin-session`), `signInAsManager` (`…/manager-session`), `signInAsMember` (confirm the helper name under `tests/e2e/helpers/`), `wipeE2EMemberBroadcasts` (`tests/e2e/helpers/broadcasts-seed.ts:366`), `clearE2ERateLimits` (global-setup helper), and the en.json copy for assertions. The proxied member is the `E2E_MEMBER_*` fixture identity — the admin submits on that member's behalf so the teardown helper (which deletes broadcasts where `requested_by_member_id` = the e2e member) cleans up exactly the rows this test creates.

- [ ] **Step 1: Write the spec (RED — fails until the UI exists; it's authored after Task 5 so it should pass, but author the assertions first and run to confirm)**

```ts
/**
 * DV-4 — Admin "Submit on behalf of member" (proxy-submit) E2E.
 *
 * Covers what jsdom can't: the real-browser compose flow + RBAC.
 *   1. admin: full proxy submit happy path → broadcast row written with
 *      requested_by_member_id = e2e-member AND actor_role/submitted_by =
 *      admin (AS9 dual-actor), verified by a direct DB read in teardown.
 *   2. manager: no entry button on /admin/broadcasts.
 *   3. manager: POST /api/admin/broadcasts/proxy-submit → 403.
 *   4. member: GET /admin/broadcasts/new is not accessible (redirect/403).
 *
 * --workers=1 mandatory. Gated on E2E_ADMIN_* (+ MANAGER/MEMBER where used).
 * Skips on a 503 (read-only-mode / flag-off) like the sibling compose spec.
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { signInAsManager } from './helpers/manager-session';
import { wipeE2EMemberBroadcasts } from './helpers/broadcasts-seed';
import { clearE2ERateLimits } from './helpers//* confirm path */ ;
import en from '../../src/i18n/messages/en.json';
import postgres from 'postgres';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const proxy = en.admin.broadcasts.proxySubmitDialog;

test.describe.configure({ timeout: 120_000 });

test.describe('@e2e DV-4 admin proxy-submit', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
    await wipeE2EMemberBroadcasts();
  });
  test.afterAll(async () => {
    await wipeE2EMemberBroadcasts();
  });

  test('admin submits a broadcast on a member behalf (AS9 dual-actor)', async ({ page }) => {
    await signInAsAdmin(page);
    const resp = await page.goto('/admin/broadcasts/new');
    if (resp && resp.status() === 503) test.skip(true, 'broadcasts flag off / read-only');
    await page.waitForLoadState('networkidle');

    // pick the e2e member via the member-picker
    await page.getByRole('combobox', { name: proxy.memberLabel }).click();
    await page.getByPlaceholder(proxy.memberPlaceholder).fill(/* e2e member company prefix */ '');
    await page.getByRole('option').first().click();

    // self-exclusion notice shows
    await expect(page.getByText(/won't receive this broadcast/i)).toBeVisible();

    // fill subject + body, choose all-members audience, submit
    await page.getByLabel(proxy.subjectLabel).fill('DV-4 proxy e2e');
    // type into the Tiptap editor (match the compose spec's editor locator)
    // select audience via SegmentPicker (all_members)
    await page.getByRole('button', { name: proxy.confirm }).click();

    // success toast + redirect to /admin/broadcasts
    await expect(page).toHaveURL(/\/admin\/broadcasts$/);
  });

  // DB verification of the dual-actor row happens in afterAll OR inline via a
  // direct postgres read keyed on requested_by_member_id = e2e member +
  // submitted_by_user_id = admin + actor_role = 'admin_proxy'.
});
```

> Read `tests/e2e/broadcast-compose-and-submit.spec.ts` to copy the exact Tiptap editor locator + the SegmentPicker interaction + the 503-skip pattern + the e2e-member company name source. For the DB dual-actor assertion, mirror `wipeE2EMemberBroadcasts`'s `postgres(dbUrl,...)` connection to SELECT the just-created broadcast and assert `requested_by_member_id` = the e2e member id, `submitted_by_user_id` = the admin user id (resolve both via the same join the helper uses), and `actor_role = 'admin_proxy'`. Place this read BEFORE the final `wipeE2EMemberBroadcasts` (inside the test, or in `afterAll` reading then wiping).

- [ ] **Step 2: Add the manager + member RBAC tests to the same describe**

```ts
  test('manager sees no proxy-submit entry button', async ({ page }) => {
    if (!process.env.E2E_MANAGER_EMAIL) { test.skip(true, 'Set E2E_MANAGER_*'); return; }
    await signInAsManager(page);
    await page.goto('/admin/broadcasts');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('link', { name: en.admin.broadcasts.proxySubmitButton })).toHaveCount(0);
  });

  test('manager POST proxy-submit → 403', async ({ page }) => {
    if (!process.env.E2E_MANAGER_EMAIL) { test.skip(true, 'Set E2E_MANAGER_*'); return; }
    await signInAsManager(page);
    const res = await page.request.post('/api/admin/broadcasts/proxy-submit', {
      data: { requestedByMemberId: '00000000-0000-4000-8000-000000000000', subject: 'x', bodyHtml: '<p>x</p>', bodySource: '<p>x</p>', segment: { kind: 'all_members' } },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(403);
  });

  test('member cannot reach /admin/broadcasts/new', async ({ page }) => {
    if (!process.env.E2E_MEMBER_EMAIL) { test.skip(true, 'Set E2E_MEMBER_*'); return; }
    // sign in as member (confirm helper) then assert redirect away from /admin/**
    // mirror an existing member-blocked-from-admin e2e assertion.
  });
```

- [ ] **Step 3: Run the e2e spec (workers=1)**

Run: `pnpm test:e2e tests/e2e/admin-proxy-submit.spec.ts --workers=1`
Expected: PASS (or clean skips if MANAGER/MEMBER env vars are unset; the admin happy-path must pass). If sign-in flakes on Upstash rate-limit, re-run (global-setup clears limits) — do not add sleeps.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/admin-proxy-submit.spec.ts
git commit -m "test(broadcasts): e2e — admin proxy-submit AS9 dual-actor + RBAC boundaries (DV-4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full gate sweep + push + PR

**Not a code task — the ship gate.** Run the local CI subset, push with the sanctioned integration skip, run the affected integration tests manually, open the PR.

- [ ] **Step 1: Run the gate sweep**

Run (in order, stop on first failure and fix):
```
pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm check:layout && pnpm check:fixme
pnpm vitest run tests/unit/broadcasts tests/unit/broadcast tests/contract/broadcasts
```
Expected: 0 lint, 0 typecheck, i18n/layout/fixme OK, all named vitest GREEN. Run `pnpm typecheck` as the **final** check after the last edit (it's not in pre-push; an earlier run misses errors from later edits).

- [ ] **Step 2: Run the affected integration tests manually**

Run: `pnpm test:integration tests/integration/broadcasts/proxy-submit-quota-cap.integration.test.ts tests/integration/broadcasts/proxy-submit-cross-tenant.integration.test.ts`
Expected: PASS. (The broadcasts audit-event-parity integration test may be RED from the unrelated COMP-1 enum drift — that is not introduced here; do not "fix" it by editing the TS enum tuple.)

- [ ] **Step 3: Push (integration pre-push gate skipped — enum drift)**

```bash
SKIP_INTEGRATION_PREPUSH=1 git push -u origin 085-dv4-admin-proxy-submit
```
(Push from the worktree; do not disturb the COMP-1 main checkout.)

- [ ] **Step 4: Open the PR to main**

```bash
gh pr create --base main --head 085-dv4-admin-proxy-submit \
  --title "DV-4: admin submit-on-behalf-of-member + quota-cap fix (T-10) + proxy read-dedup (#18)" \
  --body "$(cat <<'EOF'
## What

Wires the admin "Submit on behalf of member" UI for F7 broadcasts and folds in two pre-existing divergences found while wiring it.

### Commits / concerns
1. **Quota-cap fairness fix (T-10)** — `submitBroadcast` no longer skips the member quota cap for `actorRole='admin_proxy'`. Q12 says the member's quota counts against them regardless (security.md CHK005). At-cap proxy submit → 422 `broadcast_quota_blocked`. Rate-limit precondition (d) unchanged. Live-Neon integration test added.
2. **#18 read-dedup** — the proxy route's single `findById` (for DV-17 companyName) now feeds `proxySubmitBroadcast` via a discriminated `memberLookup` input; the redundant `memberExistsInTenant` probe is removed. not-found→404 and infra-failure→500 preserved.
3. **Admin UI** — new admin-only `/admin/broadcasts/new` reusing the compose sub-components + a new `member-picker` (mirrors the relink cmdk search). Entry button on `/admin/broadcasts`. Q16 self-exclusion microcopy + proxy error/success copy (en/th/sv).

### Tests
- Unit: quota enforcement (submit + proxy), `memberLookup` discriminated input + throw-path, `buildSegmentPayload`, `member-picker` (jsdom-safe).
- Contract: at-cap 422 + preserved 404/500/DV-17.
- Integration (live Neon, run manually): at-cap quota cap + cross-tenant isolation (Principle I).
- E2E (`--workers=1`): AS9 dual-actor full submit (DB-verified) + manager-403 (button + route) + member blocked.

### Notes
- FR-001 draft-on-behalf is DEFERRED (submit-only).
- Pushed with `SKIP_INTEGRATION_PREPUSH=1` (unrelated COMP-1 `broadcast_content_redacted` enum drift on shared Neon); affected integration tests run manually and pass.
- Security-sensitive (RBAC + quota + PII proxy) — security-engineer sign-off requested.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Report the PR URL to the user (they merge it themselves).**

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-06-20-dv4-admin-proxy-submit-design.md`):
- Option 1 (new page reusing sub-components, NOT refactoring compose-form) → Tasks 4-5. ✓
- #18 read-dedup (preserve 404/500/DV-17, no barrel touch, throw-path test) → Task 3. ✓
- Quota-cap fairness fix (T-10), keep rate-limit (d) → Task 1; integration → Task 2a; security-engineer sign-off requested in PR. ✓
- Q16 self-exclusion microcopy (en/th/sv) → Task 5 Step 1. ✓
- member-picker MIRROR (not extract) relink → Task 4 Step 4. ✓
- Drop QuotaDisplay/save-draft/template-picker → Task 5 (explicitly omitted). ✓
- FR-001 draft-on-behalf DEFERRED → stated in PR body + plan goal. ✓
- Tests: member-picker + buildSegmentPayload unit (jsdom-safe) → Task 4; AS9 full-submit e2e (DB-read, teardown via wipeE2EMemberBroadcasts, 503-skip, clearE2ERateLimits) → Task 6; manager-403 + member-403 + admin-only-button → Task 6; cross-tenant proxy integration → Task 2b. ✓
- Error code mapping: 404 not 422 for not-found (route already maps via `httpStatusForBroadcastError`), RBAC manager→403 → Task 6. ✓

**2. Placeholder scan:** The UI tasks (5, 6) contain intentional `/* … */` markers where the implementer MUST read the real sub-component props / e2e locators first — each is paired with an explicit "read X, match exactly" instruction and the surrounding load-bearing code (error map, submit body, page guard) is complete. This is deliberate (reuse-heavy feature: the sub-component prop shapes are the source of truth, not this plan) — not a vague "add error handling." The bug-fix tasks (1, 2, 3) and member-picker (4) contain complete, copy-ready code.

**3. Type consistency:** `ProxyMemberLookup` (3 arms: found+companyName / not_found / lookup_failed+message) is defined once in Task 3 and consumed identically in the route + tests. `MemberPickerOption` / `MemberPickerProps` defined in Task 4 and consumed in Task 5. `buildSegmentPayload(segment, customLines)` signature consistent across Tasks 4-5. The Task 2 integration tests' input shape is flagged to change in Task 3 (cross-task note) so they stay compiling.

---

## Execution Handoff

Offer the two execution options after the user reviews this plan (subagent-driven recommended; dispatch project agents from `.claude/agents` per the session constraint — `software-engineer` implementers, `chamber-os-qa-engineer` / `spec-compliance-auditor` task reviewers, `security-engineer` for the Task 1/2 quota + RBAC sign-off, `i18n-translation-reviewer` for the th/sv copy).
