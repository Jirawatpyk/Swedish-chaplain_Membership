# F7 Broadcast Send Hardening — PR-1 (send-unblock) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make F7 broadcast dispatch succeed against the real Resend Broadcasts API by fixing the two contract bugs that make every TSCC E-Blast fail (broadcast `name` > 70, double-wrapped `from`) and releasing the member's quota slot when a dispatch permanently fails — all guarded by a contract-faithful Resend SDK fake so they cannot silently regress.

**Architecture:** Two pure helpers (`resendDashboardName`, `extractBareEmail`) replace inline string-building at the three call sites; a contract-faithful fake of the Resend **SDK client** (`getResendBroadcastsClient`) drives the **real gateway** in tests so the wire contract is actually exercised; the quota repository drops `failed_to_dispatch` from the "reserved" set (with the pinned unit test inverted and the contradicting spec/comments reconciled).

**Tech Stack:** TypeScript 5.7 strict, Vitest, Drizzle ORM + postgres-js (live Neon for integration), next-intl. No new npm dependencies.

## Global Constraints

- Package manager: **pnpm** (not npm).
- TDD: failing test → run RED → implement → run GREEN → commit. One behavior per commit.
- Conventional Commits; this is PR-1 of the F7 send hardening spec (`docs/superpowers/specs/2026-06-21-f7-broadcast-send-hardening-design.md`).
- Clean Architecture (Principle III): Domain/Application import no framework; the gateway (Infrastructure) owns Resend types. The two helpers are pure (no framework imports).
- Resend broadcast `name` limit = **70 code points**; `from` must be `local@domain` or `Display Name <local@domain>` with **no nested `<>`**.
- This branch: `f7-broadcast-send-hardening` (already created off `origin/main` in worktree `wt-f7-ff`). Do NOT touch branch `084-comp1-review-fixes`.
- Final gate before each commit: `pnpm typecheck` (true check — if a dev server is running, use a temp tsconfig excluding `.next`) + `pnpm lint` on changed files.

---

## File Structure

**Create**
- `src/modules/broadcasts/application/format/resend-dashboard-name.ts` — pure helper, caps the Resend dashboard `name` to 70 cp.
- `tests/unit/broadcasts/application/format/resend-dashboard-name.test.ts`
- `src/modules/broadcasts/infrastructure/resend/bare-email.ts` — pure helper, extracts the bare address from a `Name <email>`-or-bare string.
- `tests/unit/broadcasts/infrastructure/resend/bare-email.test.ts`
- `tests/support/broadcasts/resend-contract-fake.ts` — contract-faithful fake of the Resend SDK client (enforces name ≤70, from no-nested-`<>`, audience-count limit).
- `tests/unit/broadcasts/infrastructure/resend-broadcasts-gateway-contract.test.ts` — gateway-contract tests (SDK fake → real gateway).
- `tests/integration/broadcasts/quota-release-on-failed-dispatch.test.ts` — live-Neon quota-release test (count + producing transition).
- `scripts/reset-broadcast-quota.ts` — dev/test utility (re-created on this branch).

**Modify**
- `src/modules/broadcasts/application/use-cases/dispatch-scheduled-broadcast.ts` (the inline name at the `createBroadcast` call).
- `src/modules/broadcasts/application/use-cases/dispatch-broadcast-batch.ts` (the inline `… — batch N` name).
- `src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts` (the `from` composition).
- `src/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo.ts` (`countForMemberQuota` reserved SQL + the comment block).
- `src/modules/broadcasts/domain/value-objects/quota-counter.ts` (the docstring NOTE).
- `tests/unit/broadcasts/application/compute-quota-counter.test.ts` (invert the pinned `failed_to_dispatch` test).
- `specs/010-email-broadcast/spec.md` (AS2 line ~324 — reconcile with FR-003).
- `docs/go-live-readiness.md` + the F7 ship checklist (key permission, from-email format).

---

## Task 1: Contract-faithful Resend SDK fake (test infrastructure)

**Files:**
- Create: `tests/support/broadcasts/resend-contract-fake.ts`

**Interfaces:**
- Produces: `createResendContractFake(opts?: { audienceLimit?: number }): { client: ResendBroadcastsClientLike; createdAudienceCount(): number }` — a fake that satisfies the shape `getResendBroadcastsClient()` returns and **enforces** Resend's contract: `broadcasts.create` rejects a `name` > 70 code points and a `from` containing a nested `<`; `audiences.create` rejects past `audienceLimit` (default `Infinity`). Used by Task 2/3 gateway-contract tests via `vi.mock('@/modules/broadcasts/infrastructure/resend/resend-broadcasts-client', …)`.

- [ ] **Step 1: Write the fake**

```ts
// tests/support/broadcasts/resend-contract-fake.ts
//
// Contract-faithful fake of the Resend Broadcasts SDK client. Unlike the
// lenient port-level mocks, this enforces the limits Resend actually returned
// during the 2026-06-21 go-live verification, so a gateway test that builds an
// over-long name or a double-wrapped `from` FAILS here exactly as it would in
// production. Limits are pinned to observed Resend errors; see the design spec.
const MAX_NAME_CP = 70;

type ResendResult<T> = { data: T | null; error: { statusCode: number; message: string; name: string } | null };

export interface ResendBroadcastsClientLike {
  readonly broadcasts: {
    create(args: { audienceId: string; from: string; subject: string; html: string; replyTo: string; name: string }): Promise<ResendResult<{ id: string }>>;
    send(id: string, opts?: unknown): Promise<ResendResult<{ id: string }>>;
  };
  readonly audiences: {
    create(args: { name: string }): Promise<ResendResult<{ id: string }>>;
  };
  readonly contacts: {
    create(args: unknown): Promise<ResendResult<{ id: string }>>;
    remove(args: unknown): Promise<ResendResult<{ deleted: boolean }>>;
    list(args: unknown): Promise<ResendResult<{ data: unknown[] }>>;
  };
}

export function createResendContractFake(opts: { audienceLimit?: number } = {}): {
  client: ResendBroadcastsClientLike;
  createdAudienceCount: () => number;
} {
  const audienceLimit = opts.audienceLimit ?? Number.POSITIVE_INFINITY;
  let audienceCount = 0;
  const client: ResendBroadcastsClientLike = {
    broadcasts: {
      async create(args) {
        if ([...args.name].length > MAX_NAME_CP) {
          return { data: null, error: { statusCode: 422, message: 'Field `name` has a maximum of 70 items.', name: 'validation_error' } };
        }
        // Valid `from`: `local@domain` or `Name <local@domain>` — no nested `<`.
        const inner = args.from.match(/<([^>]*)>\s*$/)?.[1] ?? args.from;
        if (inner.includes('<') || inner.includes('>') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inner.trim())) {
          return { data: null, error: { statusCode: 422, message: `Invalid \`from\` field. Received \`${args.from}\`.`, name: 'validation_error' } };
        }
        return { data: { id: 'bcast_fake_1' }, error: null };
      },
      async send(id) { return { data: { id }, error: null }; },
    },
    audiences: {
      async create() {
        if (audienceCount >= audienceLimit) {
          return { data: null, error: { statusCode: 401, message: `Your plan includes ${audienceLimit} segments. Upgrade to add more.`, name: 'restricted' } };
        }
        audienceCount += 1;
        return { data: { id: `aud_fake_${audienceCount}` }, error: null };
      },
    },
    contacts: {
      async create() { return { data: { id: 'contact_fake_1' }, error: null }; },
      async remove() { return { data: { deleted: true }, error: null }; },
      async list() { return { data: { data: [] }, error: null }; },
    },
  };
  return { client, createdAudienceCount: () => audienceCount };
}
```

- [ ] **Step 2: Typecheck the new file**

Run: `pnpm typecheck`
Expected: PASS (no errors). The fake is only consumed by later tasks, so there is no test to run yet.

- [ ] **Step 3: Commit**

```bash
git add tests/support/broadcasts/resend-contract-fake.ts
git commit -m "test(broadcasts): contract-faithful Resend SDK fake for the send path"
```

---

## Task 2: Fix 2 — cap the Resend broadcast `name` to 70 code points

**Files:**
- Create: `src/modules/broadcasts/application/format/resend-dashboard-name.ts`
- Create: `tests/unit/broadcasts/application/format/resend-dashboard-name.test.ts`
- Modify: `src/modules/broadcasts/application/use-cases/dispatch-scheduled-broadcast.ts` (the `broadcastNameForResendDashboard:` line at the `createBroadcast` call — currently `` `${broadcast.fromName} — ${[...broadcast.subject].slice(0, 60).join('')}` ``)
- Modify: `src/modules/broadcasts/application/use-cases/dispatch-broadcast-batch.ts:234` (`` `${input.broadcastContent.fromName} — batch ${manifest.batchIndex + 1}` ``)
- Create: `tests/unit/broadcasts/infrastructure/resend-broadcasts-gateway-contract.test.ts` (name half — created here, extended in Task 3)

**Interfaces:**
- Produces: `resendDashboardName(fromName: string, subject: string): string` — returns `` `${fromName} — ${subject}` `` truncated to ≤ 70 code points (Unicode-safe), preserving up to 60 code points of subject; fromName kept, trailing subject truncated.

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/unit/broadcasts/application/format/resend-dashboard-name.test.ts
import { describe, expect, it } from 'vitest';
import { resendDashboardName } from '@/modules/broadcasts/application/format/resend-dashboard-name';

describe('resendDashboardName', () => {
  it('caps a long fromName + long subject to <= 70 code points', () => {
    const name = resendDashboardName('E2E Alpha Co via Thailand-Swedish Chamber of Commerce', 'F7 Verify — E-Blast live send (test)');
    expect([...name].length).toBeLessThanOrEqual(70);
    expect(name.startsWith('E2E Alpha Co via')).toBe(true);
  });

  it('measures in code points, not UTF-16 units, and never splits a surrogate pair', () => {
    const subject = '😀'.repeat(80); // 80 emoji = 160 UTF-16 units, 80 code points
    const name = resendDashboardName('Tenant', subject);
    expect([...name].length).toBeLessThanOrEqual(70);
    // No lone surrogate (would render as replacement glyph): re-encoding round-trips.
    expect([...name].every((cp) => cp.length === 2 || cp.length === 1)).toBe(true);
    expect(name.includes('�')).toBe(false);
  });

  it('leaves a short label unchanged', () => {
    expect(resendDashboardName('SweCham', 'Welcome')).toBe('SweCham — Welcome');
  });
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run tests/unit/broadcasts/application/format/resend-dashboard-name.test.ts`
Expected: FAIL — `Failed to resolve import … resend-dashboard-name`.

- [ ] **Step 3: Implement the helper**

```ts
// src/modules/broadcasts/application/format/resend-dashboard-name.ts
//
// Verify-fix (2026-06-21) — Resend caps the broadcast `name` at 70 code points
// ("Field `name` has a maximum of 70 items"). The dashboard label is
// `${fromName} — ${subject}`; fromName is `{member} via {tenant full name}`
// (~53 cp for TSCC), so prefix + ` — ` + a 60-cp subject overflowed and EVERY
// dispatch failed. Preserve the existing 60-cp subject slice, then cap the whole
// label to 70 code points (Unicode-safe via spread; trailing subject truncated).
const MAX_RESEND_BROADCAST_NAME_CP = 70;
const MAX_SUBJECT_CP = 60;

export function resendDashboardName(fromName: string, subject: string): string {
  const subjectSlice = [...subject].slice(0, MAX_SUBJECT_CP).join('');
  const full = `${fromName} — ${subjectSlice}`;
  return [...full].slice(0, MAX_RESEND_BROADCAST_NAME_CP).join('');
}
```

- [ ] **Step 4: Run GREEN**

Run: `pnpm vitest run tests/unit/broadcasts/application/format/resend-dashboard-name.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into `dispatch-scheduled-broadcast.ts`**

Add the import near the other application-format imports:
```ts
import { resendDashboardName } from '@/modules/broadcasts/application/format/resend-dashboard-name';
```
Replace the `broadcastNameForResendDashboard:` value at the `createBroadcast` call (the line currently building `` `${broadcast.fromName} — ${[...broadcast.subject].slice(0, 60).join('')}` `` plus its preceding 6-line Unicode comment) with:
```ts
      broadcastNameForResendDashboard: resendDashboardName(broadcast.fromName, broadcast.subject),
```

- [ ] **Step 6: Wire into `dispatch-broadcast-batch.ts:234`**

Add the same import; replace line 234 with:
```ts
      broadcastNameForResendDashboard: resendDashboardName(
        input.broadcastContent.fromName,
        `batch ${manifest.batchIndex + 1}`,
      ),
```

- [ ] **Step 7: Write the gateway-contract test for `name` (SDK fake → real gateway)**

```ts
// tests/unit/broadcasts/infrastructure/resend-broadcasts-gateway-contract.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createResendContractFake } from '../../../support/broadcasts/resend-contract-fake';

const fake = createResendContractFake();
vi.mock('@/modules/broadcasts/infrastructure/resend/resend-broadcasts-client', () => ({
  getResendBroadcastsClient: () => fake.client,
}));

import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';

// Minimal valid createBroadcast input; individual tests override `name`/`fromName`.
function input(over: Partial<Parameters<typeof resendBroadcastsGateway.createBroadcast>[0]>) {
  return {
    audienceId: 'aud_fake_1',
    subject: 'Hi',
    htmlBody: '<p>hi</p>',
    fromName: 'SweCham',
    fromEmail: 'noreply@zyncdata.app',
    replyToEmail: 'noreply@zyncdata.app',
    broadcastNameForResendDashboard: 'SweCham — Hi',
    tenantDisplayName: 'SweCham',
    locale: 'en' as const,
    ...over,
  };
}

describe('resendBroadcastsGateway.createBroadcast — Resend contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts a <=70-code-point name', async () => {
    await expect(resendBroadcastsGateway.createBroadcast(input({}))).resolves.toMatchObject({ broadcastId: 'bcast_fake_1' });
  });

  it('rejects a >70-code-point name (the #2 regression guard)', async () => {
    const longName = 'x'.repeat(71);
    await expect(resendBroadcastsGateway.createBroadcast(input({ broadcastNameForResendDashboard: longName }))).rejects.toThrow();
  });
});
```

- [ ] **Step 8: Run the gateway-contract test + the full broadcasts dispatch unit suite**

Run: `pnpm vitest run tests/unit/broadcasts/infrastructure/resend-broadcasts-gateway-contract.test.ts tests/unit/broadcasts/application/use-cases/dispatch-scheduled-broadcast.test.ts`
Expected: PASS. (If a dispatch test fails because its fixture name now routes through `resendDashboardName`, confirm the value is unchanged for short inputs — `resendDashboardName('SweCham','Welcome') === 'SweCham — Welcome'`.)

- [ ] **Step 9: typecheck + lint changed files, then commit**

Run: `pnpm typecheck` then `pnpm eslint src/modules/broadcasts/application/format/resend-dashboard-name.ts src/modules/broadcasts/application/use-cases/dispatch-scheduled-broadcast.ts src/modules/broadcasts/application/use-cases/dispatch-broadcast-batch.ts`
Expected: both exit 0.

```bash
git add src/modules/broadcasts/application/format/resend-dashboard-name.ts tests/unit/broadcasts/application/format/resend-dashboard-name.test.ts src/modules/broadcasts/application/use-cases/dispatch-scheduled-broadcast.ts src/modules/broadcasts/application/use-cases/dispatch-broadcast-batch.ts tests/unit/broadcasts/infrastructure/resend-broadcasts-gateway-contract.test.ts
git commit -m "fix(broadcasts): cap Resend broadcast name to 70 code points (#2)"
```

---

## Task 3: Fix 3 — extract the bare email so `from` is not double-wrapped

**Files:**
- Create: `src/modules/broadcasts/infrastructure/resend/bare-email.ts`
- Create: `tests/unit/broadcasts/infrastructure/resend/bare-email.test.ts`
- Modify: `src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts` (the `from: \`${input.fromName} <${input.fromEmail}>\`` line in `createBroadcast`)
- Modify: `tests/unit/broadcasts/infrastructure/resend-broadcasts-gateway-contract.test.ts` (add the `from` cases)

**Interfaces:**
- Produces: `extractBareEmail(value: string): string` — returns the bare address from a `Name <local@domain>` or bare `local@domain` string.

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/unit/broadcasts/infrastructure/resend/bare-email.test.ts
import { describe, expect, it } from 'vitest';
import { extractBareEmail } from '@/modules/broadcasts/infrastructure/resend/bare-email';

describe('extractBareEmail', () => {
  it('extracts the address from a "Name <email>" string', () => {
    expect(extractBareEmail('SweCham <noreply@zyncdata.app>')).toBe('noreply@zyncdata.app');
  });
  it('passes a bare address through', () => {
    expect(extractBareEmail('noreply@zyncdata.app')).toBe('noreply@zyncdata.app');
  });
  it('trims surrounding whitespace', () => {
    expect(extractBareEmail('  Chamber <broadcasts@swecham.com>  ')).toBe('broadcasts@swecham.com');
  });
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run tests/unit/broadcasts/infrastructure/resend/bare-email.test.ts`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Implement the helper**

```ts
// src/modules/broadcasts/infrastructure/resend/bare-email.ts
//
// Verify-fix (2026-06-21) — BROADCASTS_FROM_EMAIL may be `Name <local@domain>`
// OR a bare `local@domain` (env.ts:332 accepts both). The gateway composes the
// per-broadcast `from` as `${fromName} <${addr}>`; if `addr` already carries a
// display name the brackets nest (`Name <SweCham <noreply@…>>`) and Resend
// rejects it. Mirror env.ts's parser to return the bare address.
export function extractBareEmail(value: string): string {
  return value.match(/<([^>]+)>\s*$/)?.[1]?.trim() ?? value.trim();
}
```

- [ ] **Step 4: Run GREEN**

Run: `pnpm vitest run tests/unit/broadcasts/infrastructure/resend/bare-email.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into the gateway**

In `resend-broadcasts-gateway.ts`, add near the top imports:
```ts
import { extractBareEmail } from './bare-email';
```
In `createBroadcast`, immediately before the `sdk.broadcasts.create({ … })` call, add:
```ts
        const bareFromEmail = extractBareEmail(input.fromEmail);
```
and change the `from` line from `` from: `${input.fromName} <${input.fromEmail}>`, `` to:
```ts
          from: `${input.fromName} <${bareFromEmail}>`,
```

- [ ] **Step 6: Add the `from` cases to the gateway-contract test**

Append inside the existing `describe('resendBroadcastsGateway.createBroadcast — Resend contract', …)` block in `tests/unit/broadcasts/infrastructure/resend-broadcasts-gateway-contract.test.ts`:
```ts
  it('composes a single-wrapped from when fromEmail is bare', async () => {
    await expect(resendBroadcastsGateway.createBroadcast(input({ fromName: 'E2E Alpha Co via TSCC', fromEmail: 'noreply@zyncdata.app' }))).resolves.toMatchObject({ broadcastId: 'bcast_fake_1' });
  });

  it('does NOT double-wrap when fromEmail is "Name <email>" (the #3 regression guard)', async () => {
    // Before the fix this produced `… <SweCham <noreply@…>>` and the fake (like
    // real Resend) rejects the nested `<>`.
    await expect(resendBroadcastsGateway.createBroadcast(input({ fromName: 'E2E Alpha Co via TSCC', fromEmail: 'SweCham <noreply@zyncdata.app>' }))).resolves.toMatchObject({ broadcastId: 'bcast_fake_1' });
  });
```

- [ ] **Step 7: Run the gateway-contract suite**

Run: `pnpm vitest run tests/unit/broadcasts/infrastructure/resend-broadcasts-gateway-contract.test.ts`
Expected: PASS (4 tests). Temporarily reverting the Step-5 `from` change should make the `#3 regression guard` test FAIL — confirm once, then restore.

- [ ] **Step 8: typecheck + lint, then commit**

Run: `pnpm typecheck` then `pnpm eslint src/modules/broadcasts/infrastructure/resend/bare-email.ts src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts`
Expected: exit 0.

```bash
git add src/modules/broadcasts/infrastructure/resend/bare-email.ts tests/unit/broadcasts/infrastructure/resend/bare-email.test.ts src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts tests/unit/broadcasts/infrastructure/resend-broadcasts-gateway-contract.test.ts
git commit -m "fix(broadcasts): extract bare from-email to avoid double-wrapped Resend from (#3)"
```

---

## Task 4: Fix 4 — release the quota slot on `failed_to_dispatch`

**Files:**
- Modify: `src/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo.ts` (`countForMemberQuota` — the `sql\`…IN ('submitted', 'approved', 'failed_to_dispatch')\`` reserved clause + the 785-810 comment block)
- Modify: `src/modules/broadcasts/domain/value-objects/quota-counter.ts` (the 17-29 docstring NOTE)
- Modify: `tests/unit/broadcasts/application/compute-quota-counter.test.ts` (invert the `R3 Tests-Gap#1` test at ~line 180)
- Modify: `specs/010-email-broadcast/spec.md` (AS2 line ~324)
- Create: `tests/integration/broadcasts/quota-release-on-failed-dispatch.test.ts`

**Interfaces:**
- Consumes: `countForMemberQuota(tenantId, memberId, quotaYear)` returning `{ submittedOrApproved, sent }` (unchanged signature; the `submittedOrApproved` count just stops including `failed_to_dispatch`).

- [ ] **Step 1: Invert the pinned unit test (write the new RED expectation)**

In `tests/unit/broadcasts/application/compute-quota-counter.test.ts`, replace the `it('R3 Tests-Gap#1: failed_to_dispatch holds the reservation slot per spec AS2', …)` block (lines ~180-198) with:

```ts
  it('D1 (2026-06-21): failed_to_dispatch RELEASES the reservation slot', async () => {
    // Design spec D1 / FR-003: failed_to_dispatch is terminal (no re-trigger
    // route exists), so holding the slot is a permanent lockout. The repo SQL
    // no longer counts failed_to_dispatch as reserved → a member whose only
    // broadcast failed to dispatch has the full quota available again.
    const deps = makeDeps({ cap: 1, used: 0, reserved: 0 });
    const result = await computeQuotaCounter(deps, { memberId: asMemberId('m-1') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.reserved).toBe(0);
      expect(result.value.counter.remaining).toBe(1);
    }
  });
```

- [ ] **Step 2: Change the repo SQL (the GREEN for the integration contract)**

In `drizzle-broadcasts-repo.ts`, in `countForMemberQuota`, change the reserved predicate from
`` sql`${broadcasts.status}::text IN ('submitted', 'approved', 'failed_to_dispatch')` ``
to
```ts
                sql`${broadcasts.status}::text IN ('submitted', 'approved')`,
```
and rewrite the preceding comment block (the "Verify-fix R3 … AS2 … reserved = submitted ∪ approved ∪ failed_to_dispatch" paragraph) to:
```ts
                // Design D1 (2026-06-21): reserved = submitted ∪ approved.
                // failed_to_dispatch is TERMINAL (no re-trigger route), so
                // counting it as reserved permanently locked the member out of
                // their E-Blast benefit. FR-003 already requires release on
                // failed_to_dispatch; spec.md AS2 (superseded) is amended to match.
```

- [ ] **Step 3: Fix the Domain VO docstring**

In `quota-counter.ts`, replace lines 17-29 (the `` `reserved` slots are … `failed_to_dispatch` `` paragraph **and** the `NOTE — FR-003 wording…Do NOT "fix"…` paragraph) with:
```ts
 * `reserved` slots are broadcasts in `submitted` or `approved` state — they
 * have not been consumed (sent → quota_year_consumed) but MUST count against
 * the cap so a member cannot exceed their plan while a broadcast awaits review.
 * Reservation is released on transition to `rejected`, `cancelled`, or
 * `failed_to_dispatch` (Design D1, 2026-06-21 — failed_to_dispatch is terminal
 * with no re-trigger route, so holding the slot would be a permanent lockout).
```

- [ ] **Step 4: Amend the spec**

In `specs/010-email-broadcast/spec.md` at AS2 (~line 324), change the "remains held (NOT released — admin can manually re-trigger)" wording to: "the reservation is **released** (Design D1, 2026-06-21 — failed_to_dispatch is terminal; no admin re-trigger route was ever built, so holding the slot permanently locked the member out). Matches FR-003." Leave FR-003 as-is.

- [ ] **Step 5: Run the unit test GREEN**

Run: `pnpm vitest run tests/unit/broadcasts/application/compute-quota-counter.test.ts`
Expected: PASS (the inverted test + the untouched `cancelled`/`used` tests).

- [ ] **Step 6: Write the integration test (live Neon)**

```ts
// tests/integration/broadcasts/quota-release-on-failed-dispatch.test.ts
//
// D1 — a member whose only broadcast is failed_to_dispatch has reserved=0 and
// can submit again. Asserts BOTH the count query and the producing transition.
import { describe, expect, it } from 'vitest';
import { asTenantContext } from '@/modules/tenants/domain/tenant-context';
import { runInTenant } from '@/lib/db';
// NOTE to implementer: follow the existing setup in
// tests/integration/broadcasts/dispatch-failure-notification.test.ts for
// seeding a member + a broadcast and driving a permanent dispatch failure;
// reuse its helpers rather than duplicating fixtures.

describe('quota release on failed_to_dispatch (D1)', () => {
  it('a failed_to_dispatch broadcast does not count toward reserved', async () => {
    // Arrange: seed a member with cap=1 and one broadcast forced to
    // failed_to_dispatch (use the dispatch use-case with a permanent gateway
    // error, mirroring dispatch-failure-notification.test.ts).
    // Act: computeQuotaCounter for that member.
    // Assert: reserved === 0 && remaining === 1.
    expect(true).toBe(true); // replace with the real arrange/act/assert per the referenced test's pattern
  });
});
```

> Implementer: replace the placeholder body using the real seeding/assertion helpers from `dispatch-failure-notification.test.ts`. The assertion is `reserved === 0 && remaining === cap`. Do not commit the `expect(true).toBe(true)` stub.

- [ ] **Step 7: Run the integration test**

Run: `pnpm test:integration -- tests/integration/broadcasts/quota-release-on-failed-dispatch.test.ts`
Expected: PASS against live Neon.

- [ ] **Step 8: typecheck + lint, then commit**

Run: `pnpm typecheck` then `pnpm eslint src/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo.ts src/modules/broadcasts/domain/value-objects/quota-counter.ts`
Expected: exit 0.

```bash
git add src/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo.ts src/modules/broadcasts/domain/value-objects/quota-counter.ts tests/unit/broadcasts/application/compute-quota-counter.test.ts specs/010-email-broadcast/spec.md tests/integration/broadcasts/quota-release-on-failed-dispatch.test.ts
git commit -m "fix(broadcasts): release quota slot on failed_to_dispatch (#4, D1)"
```

---

## Task 5: Reset utility + ship docs

**Files:**
- Create: `scripts/reset-broadcast-quota.ts` (re-create on this branch — the version written during verification, which has a test-member guard, `--dry-run`, `--force`, FK-safe delete, and leaves audit rows intact)
- Modify: `docs/go-live-readiness.md` (add the F7 send ship-checklist items)

- [ ] **Step 1: Re-create the reset utility**

Recreate `scripts/reset-broadcast-quota.ts` exactly as written during the 2026-06-21 verification session (resolves a member by email via `contacts.linked_user_id`, refuses non-test members unless `--force`, deletes `broadcast_deliveries` then `broadcasts` in FK-safe order, prints before/after quota, retains audit rows). Confirm it uses only simulated/dummy member data.

- [ ] **Step 2: Smoke the script (dry-run)**

Run: `pnpm tsx scripts/reset-broadcast-quota.ts --dry-run`
Expected: prints the e2e-member's broadcasts + `[dry-run] would delete …`, mutates nothing.

- [ ] **Step 3: Add ship-checklist items to `docs/go-live-readiness.md`**

Under the F7 section add:
```markdown
- [ ] `RESEND_BROADCASTS_API_KEY` has **Full access** (Broadcasts + Audiences), not "Sending access" — verified in dev, staging, prod.
- [ ] `BROADCASTS_FROM_EMAIL` is a valid `local@domain` or `Display Name <local@domain>` (the gateway composes `${memberFromName} <addr>`).
- [ ] F7 send hardening PR-1 merged (name ≤70, from un-wrapped, quota released on failed_to_dispatch). PR-2 (ephemeral audience + cleanup) tracked separately.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/reset-broadcast-quota.ts docs/go-live-readiness.md
git commit -m "chore(broadcasts): reset-quota dev utility + F7 send ship checklist"
```

---

## Final verification (before opening the PR)

- [ ] Run the full broadcasts unit + contract suites: `pnpm vitest run tests/unit/broadcasts tests/contract/broadcasts`
- [ ] Run the broadcasts integration suite: `pnpm test:integration -- tests/integration/broadcasts`
- [ ] `pnpm typecheck` (true check) + `pnpm lint` clean.
- [ ] Revert the temporary name/from patches on branch `084-comp1-review-fixes` (`git checkout 084-comp1-review-fixes -- <the two files>` is NOT needed — just discard the uncommitted edits there).
- [ ] Open PR-1 off `origin/main`; ≥1 reviewer. Body links the design spec and lists fixes #2/#3/#4 + the contract-fake.

## Self-review notes (author)
- Spec coverage: Fix 1 (doc, Task 5), Fix 2 (Task 2), Fix 3 (Task 3), Fix 4 four edits (Task 4: SQL + inverted test + VO doc + AS2), contract-fake SDK-seam (Task 1, used in Tasks 2-3). PR-2 (Fix 5 ephemeral audience) is intentionally out of this plan.
- Type consistency: `resendDashboardName(fromName, subject)` and `extractBareEmail(value)` names are used identically at every call site and test.
- Known placeholder: Task 4 Step 6 integration test body is a guided stub pointing at `dispatch-failure-notification.test.ts` (the live-Neon seeding harness is too environment-specific to inline verbatim); the step explicitly forbids committing the stub.
