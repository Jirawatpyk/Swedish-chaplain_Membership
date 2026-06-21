# Member Erasure — US2a (F1 Linked-User Erasure) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anonymise the F1 login account(s) linked to an erased member — email → a globally-unique non-routable sentinel, password invalidated, display name `[erased]`, sessions revoked, `disabled` — so a GDPR-Art.17-erased member can no longer authenticate, with a durable `user_erased` audit; wired into `eraseMember` as a post-commit best-effort cascade.

**Architecture:** A net-new `eraseUser` use-case in the **auth** module (`src/modules/auth/application/`) that runs in an **owner-role `db.transaction`** (the `users` table is cross-tenant — no `tenant_id`, no RLS — so it cannot join the members `runInTenant` tx; this mirrors `delete-invited-user.ts`). It anonymises the `users` row idempotently (re-running on an already-sentinel email is a no-op), revokes sessions (reusing the existing session-revocation), and emits `user_erased` (a net-new auth-taxonomy audit event, registered in the 4 required places). The members module reaches it through a new `UserErasurePort` + adapter; `eraseMember` surfaces the linked-user id set (already read inside its atomic scrub tx for the session cascade) to its post-commit section and calls the port per user id, flipping `allCascadesClean = false` on any failure so the US2d reconciler re-drives it.

**Tech Stack:** TypeScript 5.7 strict · Drizzle ORM + Neon Postgres · `@node-rs/argon2` (only to NULL the hash — no hashing) · Vitest (unit + live-Neon integration) · `Result<T,E>` · Clean Architecture (Principle III) · auth append-only `audit_log`.

**⚠️ Security gate:** this is an auth / PII / credential surface → the Review gate requires **≥2 reviewers + 1 security-checklist sign-off** (Constitution Principle I + Gate 9). Consider shipping US2a as its own PR (stacked on the US1 PR #98 or on `main` after #98 merges).

---

## Pre-flight (read before Task 1)

The exact shapes this plan depends on (verified 2026-06-16):

- **`users` schema** — `src/modules/auth/infrastructure/db/schema.ts:404-439`. `id uuid PK defaultRandom`; `email text NOT NULL`; `passwordHash text` (**nullable** — NULL while `status='pending'`); `displayName text` (nullable); `status` enum `'pending'|'active'|'disabled'`; `role` enum `'admin'|'manager'|'member'`. **NO `tenant_id` column.** Unique index `users_email_lower_unique` on `sql\`lower(email)\`` — **GLOBAL + case-insensitive + functional**. So the sentinel must be globally unique + survive lower-casing → embed the user id: `erased+{userId}@erased.invalid`.
- **`delete-invited-user.ts`** — `src/modules/auth/application/delete-invited-user.ts`. The auth-module convention to mirror: `db.transaction(async (tx) => …)` (owner role / BYPASSRLS — `users` is cross-tenant + unscoped by RLS), `Pick<UserRepo,'…'>` + `Pick<AuditRepo,'appendInTx'>` narrow deps, deps default from `@/lib/auth-deps`, never-throws → typed `err({code:'…'})`, `audit.appendInTx` at the **tail** of the tx.
- **Auth audit `appendInTx`** — `src/modules/auth/infrastructure/db/audit-repo.ts:52-83,156-162`. `AppendAuditEvent = { eventType: AuditEventType; actorUserId: ActorRef; targetUserId?: UserId|null; sourceIp?: string|null; summary: string; requestId: string; reason?: string }`. `appendInTx(tx, event)` is **never-throws** (catches DB error → `logger.error` + `authMetrics.auditMissing`) — so it MUST be the tail statement of the tx (a poisoned tx swallows silently). `summary` truncated to 500.
- **Auth audit registration (4 places)** for `user_erased`:
  1. `src/modules/auth/domain/audit-event.ts:36-108` — the `AUDIT_EVENT_TYPES` `as const` array (currently **32** elements). Append `'user_erased'` → 33.
  2. `src/modules/auth/infrastructure/db/schema.ts` — the `pgEnum('audit_event_type', [...])` (shared enum; tail at ~`:331-333` is the COMP-1 pair). Append `'user_erased'`.
  3. A **migration** `ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'user_erased'` (the enum is a live DB type).
  4. `tests/unit/auth/domain/audit-event.test.ts:33` — `expect(AUDIT_EVENT_TYPES).toHaveLength(32)` → bump to 33.
  5. **`tests/integration/audit/completeness.test.ts:75-76`** — the SECOND auth count test (the auth taxonomy has TWO: this `tests/integration/` one + the unit one above). `expect(AUDIT_EVENT_TYPES.length).toBe(32)` + `new Set(...).size).toBe(32)` → both `33`; update its describe/it titles too. **Easy to miss** (it's in `tests/integration/` so a unit-only run stays green) — this is the "add audit event = domain const + pgEnum + 2 count tests" pattern. Running it also round-trips `user_erased` against live Neon (proves the migration applied). (The `all-audit-event-types.test.ts` `>100`/sorted/deduped check + the per-module scope-filtered parity tests auto-pass.)
- **Session revocation** — `src/modules/members/application/ports/session-revocation-port.ts:23-36` + adapter `src/modules/members/infrastructure/adapters/auth-session-revocation-port.ts:22-47`. `revokeAllForInTx(tx, userId, 'admin_force')` DELETEs `sessions WHERE user_id = userId`, returns `Result<{revokedCount}, RepoError>`. US1 already calls this **inside** the members atomic tx. The new `eraseUser` does its anonymise + a session-revoke in its **own** owner tx (idempotent — re-revoking 0 sessions is fine; belt-and-suspenders for the standalone/reconciler path).
- **Member → user link** — `contacts.linked_user_id` (`src/modules/members/infrastructure/db/schema-contacts.ts:71`). `ContactRepo.listLinkedUserIdsForMemberInTx(tx, memberId): Promise<string[]>` (`drizzle-contact-repo.ts:211-230`) returns the **deduped-by-caller** non-removed contacts' linked user ids. US1 reads this **before** the contacts scrub (Bug I-1) inside the atomic tx as `uniqueLinkedUserIds` — this plan surfaces it to the post-commit section.
- **`eraseMember` post-commit cascade section** — `src/modules/members/application/use-cases/erase-member.ts` (the F7 + F8 `try/catch` blocks end ~`:403`, the `// 4. Completion proof` `if (allCascadesClean)` block is ~`:405-435`). New cascades slot **between** the F8 catch and the completion comment. `EraseMemberDeps` is `:62-72`; `EraseMemberResult.cascadesComplete` is `:51-60`.
- **Composition root** — `src/modules/members/members-deps.ts:168-193` (`buildEraseMemberDeps`).
- **Run commands:** unit `pnpm vitest run <path>`; integration `pnpm vitest run -c vitest.integration.config.ts <path>`; migrate `pnpm drizzle-kit migrate`; true typecheck via a temp tsconfig excluding `.next` (the dev server masks `pnpm typecheck`). Next free migration: run `ls drizzle/migrations/*.sql | tail -1` (US1 ended at 0221; confirm the true HEAD before writing — other branches may have advanced it).

**File-structure map (US2a creates/modifies):**
- Create `drizzle/migrations/0XXX_auth_user_erased_audit.sql` — `ALTER TYPE audit_event_type ADD VALUE 'user_erased'`.
- Modify `src/modules/auth/domain/audit-event.ts` — add `'user_erased'` to `AUDIT_EVENT_TYPES`.
- Modify `src/modules/auth/infrastructure/db/schema.ts` — add `'user_erased'` to the drizzle `pgEnum`.
- Modify `tests/unit/auth/domain/audit-event.test.ts` — 32 → 33.
- Modify `src/modules/auth/infrastructure/db/user-repo.ts` — add `anonymiseErasedInTx`.
- Create `src/modules/auth/application/erase-user.ts` — the `eraseUser` use-case.
- Modify `src/lib/auth-deps.ts` — add `defaultEraseUserDeps`.
- Modify `src/modules/auth/index.ts` (barrel) — export `eraseUser` + its types.
- Create `src/modules/members/application/ports/user-erasure-port.ts` — `UserErasurePort`.
- Create `src/modules/members/infrastructure/adapters/auth-user-erasure-adapter.ts` — the adapter.
- Modify `src/modules/members/application/use-cases/erase-member.ts` — surface linked-user ids + add the F1 cascade block + the new dep.
- Modify `src/modules/members/members-deps.ts` — wire the adapter into `buildEraseMemberDeps`.
- Tests: `tests/unit/auth/application/erase-user.test.ts`, `tests/integration/auth/erase-user.test.ts`, `tests/integration/members/erase-member-f1-user.test.ts`, `tests/unit/members/application/erase-member.test.ts` (+ the new cascade cases), `tests/unit/members/members-deps.test.ts` (+ the new dep in the guard).

---

## Task 1: Register the `user_erased` auth audit event (4 places)

**Files:**
- Test: `tests/unit/auth/domain/audit-event.test.ts`
- Modify: `src/modules/auth/domain/audit-event.ts`, `src/modules/auth/infrastructure/db/schema.ts`
- Create: `drizzle/migrations/0XXX_auth_user_erased_audit.sql` + journal entry

- [ ] **Step 1: Bump the auth audit count test to 33 (RED)**

In `tests/unit/auth/domain/audit-event.test.ts` (~line 33):
```ts
    expect(AUDIT_EVENT_TYPES).toHaveLength(33);
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run tests/unit/auth/domain/audit-event.test.ts`
Expected: FAIL — array is still length 32.

- [ ] **Step 3: Add `'user_erased'` to the domain const**

In `src/modules/auth/domain/audit-event.ts`, append to the `AUDIT_EVENT_TYPES` `as const` array (after the last element `'password_malformed_hash_detected',`):
```ts
  'password_malformed_hash_detected',
  // COMP-1 US2a — Member Erasure F1 linked-user erasure (GDPR Art.17/PDPA §33).
  // Emitted by `eraseUser` after anonymising the users row. No PII in payload.
  'user_erased',
] as const;
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm vitest run tests/unit/auth/domain/audit-event.test.ts`
Expected: PASS — length 33; the completeness loop still holds.

- [ ] **Step 5: Add `'user_erased'` to the drizzle pgEnum**

In `src/modules/auth/infrastructure/db/schema.ts`, inside `pgEnum('audit_event_type', [ … ])`, append after `'member_erased',`:
```ts
  'member_erased',
  // COMP-1 US2a — F1 linked-user erasure.
  'user_erased',
]);
```

- [ ] **Step 6: Write the migration**

Confirm the next free index (`ls drizzle/migrations/*.sql | tail -1`). Create `drizzle/migrations/0XXX_auth_user_erased_audit.sql`:
```sql
-- COMP-1 US2a — Member Erasure F1 linked-user erasure: new audit_event_type.
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'user_erased';
```
Append the journal entry in `drizzle/migrations/meta/_journal.json` (idx = the new number, `when` strictly greater than the prior entry's, tag = the filename), mirroring the 0221 entry shape.

- [ ] **Step 7: Apply + verify the enum on live Neon**

Run: `pnpm drizzle-kit migrate`
Verify `user_erased` is present in `pg_enum` for `audit_event_type` (quick check via the project's enum-check script or a `SELECT`).

- [ ] **Step 8: Run the live enum-parity guard (if present)**

Run: `pnpm vitest run -c vitest.integration.config.ts` for any auth/shared `assert-enum-parity` test that covers `audit_event_type`.
Expected: PASS — the DB enum and the TS const agree.

- [ ] **Step 9: Commit**

```bash
git add drizzle/migrations/0XXX_auth_user_erased_audit.sql drizzle/migrations/meta/_journal.json src/modules/auth/domain/audit-event.ts src/modules/auth/infrastructure/db/schema.ts tests/unit/auth/domain/audit-event.test.ts
git commit -m "feat(auth): register user_erased audit event type (COMP-1 US2a)"
```

---

## Task 2: `UserRepo.anonymiseErasedInTx` — the users-row scrub

**Files:**
- Modify: `src/modules/auth/infrastructure/db/user-repo.ts`
- Test: `tests/integration/auth/erase-user.test.ts` (create — the repo method is tested via the live UPDATE)

This is the actual anonymisation UPDATE. Idempotent: keyed off the deterministic sentinel email so a re-run produces the identical row.

- [ ] **Step 1: Write the failing integration test (RED)**

Create `tests/integration/auth/erase-user.test.ts`. Reuse the auth integration seed helpers (`createActiveTestUser` / a raw user insert + a raw `db` select; find the pattern in an existing `tests/integration/auth/*.test.ts`). Test the repo method directly:
```ts
import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo'; // confirm the export

describe('UserRepo.anonymiseErasedInTx', () => {
  it('anonymises email→sentinel, NULLs password, name→[erased], disables', async () => {
    const user = await seedActiveUser({ email: 'Anders@Example.com', displayName: 'Anders Svensson' });
    const result = await db.transaction((tx) => userRepo.anonymiseErasedInTx(tx, user.id));
    expect(result.ok).toBe(true);

    const row = await rawSelectUser(user.id);
    expect(row.email).toBe(`erased+${user.id}@erased.invalid`);
    expect(row.password_hash).toBeNull();
    expect(row.display_name).toBe('[erased]');
    expect(row.status).toBe('disabled');
  });

  it('is idempotent — a second run keeps the same sentinel (no unique-index error)', async () => {
    const user = await seedActiveUser({ email: 'b@example.com' });
    await db.transaction((tx) => userRepo.anonymiseErasedInTx(tx, user.id));
    const second = await db.transaction((tx) => userRepo.anonymiseErasedInTx(tx, user.id));
    expect(second.ok).toBe(true);
    const row = await rawSelectUser(user.id);
    expect(row.email).toBe(`erased+${user.id}@erased.invalid`);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run -c vitest.integration.config.ts tests/integration/auth/erase-user.test.ts`
Expected: FAIL — `userRepo.anonymiseErasedInTx is not a function`.

- [ ] **Step 3: Add the method to `UserRepo`**

In `src/modules/auth/infrastructure/db/user-repo.ts`, add to the `UserRepo` interface + the implementation. The sentinel is computed from the id; the UPDATE is keyed by id. (`DbTx` is the owner-tx type used by `delete-invited-user`.)
```ts
// In the UserRepo interface:
  anonymiseErasedInTx(
    tx: DbTx,
    userId: string,
  ): Promise<Result<{ readonly erased: boolean }, RepoError>>;
```
```ts
// In the impl (use the file's existing `users` import + `eq`/`sql` from drizzle-orm + the file's RepoError style):
  async anonymiseErasedInTx(tx, userId) {
    try {
      const sentinelEmail = `erased+${userId}@erased.invalid`;
      const updated = await tx
        .update(users)
        .set({
          email: sentinelEmail,
          passwordHash: null,
          displayName: '[erased]',
          status: 'disabled',
          emailVerified: false,
          requiresPasswordReset: false,
        })
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      return ok({ erased: updated.length === 1 });
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },
```
Notes: `email` is set to the lowercase sentinel so the functional `lower(email)` unique index sees `erased+{id}@erased.invalid` (always unique per user). `password_hash → null` + `status → 'disabled'` both block authentication (defence in depth). `display_name → '[erased]'`. Use the EXACT `Result`/`RepoError`/`ok`/`err` helpers + the `DbTx` type the surrounding `user-repo.ts` already uses (read the file — it may use a different error shape than the members `RepoError`; match it).

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm vitest run -c vitest.integration.config.ts tests/integration/auth/erase-user.test.ts`
Expected: PASS — both cases.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/infrastructure/db/user-repo.ts tests/integration/auth/erase-user.test.ts
git commit -m "feat(auth): UserRepo.anonymiseErasedInTx users-row scrub (COMP-1 US2a)"
```

---

## Task 3: `eraseUser` use-case (owner-tx, idempotent, audit + session revoke)

**Files:**
- Create: `src/modules/auth/application/erase-user.ts`
- Modify: `src/lib/auth-deps.ts` (add `defaultEraseUserDeps`)
- Modify: `src/modules/auth/index.ts` (barrel export)
- Test: `tests/unit/auth/application/erase-user.test.ts`

- [ ] **Step 1: Write the failing unit test (RED)**

Create `tests/unit/auth/application/erase-user.test.ts` (mock the repo + audit, mirror how other auth use-case unit tests stub `db.transaction`):
```ts
import { describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';
import { eraseUser } from '@/modules/auth/application/erase-user';

vi.mock('@/lib/db', () => ({ db: { transaction: (fn: (tx: never) => unknown) => fn({} as never) } }));

const META = { actorUserId: 'admin-1', requestId: 'req-1', sourceIp: null };

function buildDeps() {
  return {
    users: { anonymiseErasedInTx: vi.fn(async () => ok({ erased: true })) },
    sessions: { revokeAllForInTx: vi.fn(async () => ok({ revokedCount: 2 })) },
    audit: { appendInTx: vi.fn(async () => undefined) },
  };
}

describe('eraseUser', () => {
  it('anonymises the user, revokes sessions, emits user_erased', async () => {
    const deps = buildDeps();
    const res = await eraseUser({ userId: 'u-1', ...META }, deps as never);
    expect(res.ok).toBe(true);
    expect(deps.users.anonymiseErasedInTx).toHaveBeenCalledWith(expect.anything(), 'u-1');
    expect(deps.sessions.revokeAllForInTx).toHaveBeenCalledWith(expect.anything(), 'u-1', 'admin_force');
    const ev = deps.audit.appendInTx.mock.calls[0]?.[1];
    expect(ev.eventType).toBe('user_erased');
    expect(ev.targetUserId).toBe('u-1');
  });

  it('returns ok with erased:false when the user row is already gone', async () => {
    const deps = buildDeps();
    deps.users.anonymiseErasedInTx = vi.fn(async () => ok({ erased: false }));
    const res = await eraseUser({ userId: 'missing', ...META }, deps as never);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.erased).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run tests/unit/auth/application/erase-user.test.ts`
Expected: FAIL — cannot import `eraseUser`.

- [ ] **Step 3: Implement `eraseUser`**

Create `src/modules/auth/application/erase-user.ts` (mirror `delete-invited-user.ts`'s shape: owner `db.transaction`, `Pick` deps, never-throws → typed err, audit at the tail):
```ts
/**
 * `erase-user` use case (COMP-1 US2a — Member Erasure F1 linked-user erasure).
 *
 * Anonymises an F1 login account so a GDPR-Art.17-erased member can no longer
 * authenticate: email → a globally-unique non-routable sentinel
 * (`erased+{userId}@erased.invalid`, lower-cased to satisfy the functional
 * `lower(email)` unique index), password_hash → NULL, display_name → '[erased]',
 * status → 'disabled'; sessions revoked. Emits `user_erased` (no PII payload).
 *
 * Runs in an OWNER-role `db.transaction` (the `users` table is cross-tenant —
 * no tenant_id, no RLS — so it cannot join a members `runInTenant` tx). Mirrors
 * `delete-invited-user.ts`. Idempotent: a re-run produces the identical sentinel
 * row; `erased:false` means the row was already gone (never existed). Audit is
 * the TAIL statement (auth `appendInTx` never-throws — a poisoned tx swallows).
 */
import { db, type DbTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { err, ok, type Result } from '@/lib/result';
import type { ActorRef } from '@/modules/auth/domain/audit-event';
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { defaultEraseUserDeps } from '@/lib/auth-deps';

export interface EraseUserInput {
  readonly userId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
}

export type EraseUserError = { readonly code: 'erase-user-failed'; readonly cause: unknown };

export interface EraseUserDeps {
  readonly users: Pick<UserRepo, 'anonymiseErasedInTx'>;
  readonly sessions: { revokeSessionsForUserInTx(tx: DbTx, userId: string): Promise<Result<{ revokedCount: number }, unknown>> };
  readonly audit: Pick<AuditRepo, 'appendInTx'>;
}

export async function eraseUser(
  input: EraseUserInput,
  deps: EraseUserDeps = defaultEraseUserDeps,
): Promise<Result<{ readonly erased: boolean }, EraseUserError>> {
  try {
    const outcome = await db.transaction(async (tx) => {
      const anonymised = await deps.users.anonymiseErasedInTx(tx, input.userId);
      if (!anonymised.ok) throw new Error('anonymise_failed', { cause: anonymised.error });

      // Revoke any live sessions (idempotent — 0 sessions is fine on a re-run /
      // when US1 already revoked them inside the members tx).
      const revoked = await deps.sessions.revokeSessionsForUserInTx(tx, input.userId);
      if (!revoked.ok) throw new Error('session_revoke_failed', { cause: revoked.error });

      // Audit at the TAIL (auth appendInTx never-throws — must be last).
      await deps.audit.appendInTx(tx, {
        eventType: 'user_erased',
        actorUserId: input.actorUserId as ActorRef,
        targetUserId: input.userId as never,
        sourceIp: input.sourceIp,
        summary: `user_erased ${input.userId}`,
        requestId: input.requestId,
      });

      return { erased: anonymised.value.erased };
    });
    return ok(outcome);
  } catch (e) {
    logger.error({ requestId: input.requestId, err: e instanceof Error ? e.message : String(e) }, 'erase_user.failed');
    return err({ code: 'erase-user-failed', cause: e });
  }
}
```
**IMPORTANT — the session-revoke dep:** the existing `authSessionRevocationPort.revokeAllForInTx(tx, userId, reason)` takes a `TenantTx`, but `eraseUser` runs in an owner `DbTx`. Read `auth-session-revocation-port.ts` — its impl just `tx.delete(sessions).where(eq(sessions.userId, userId))`, which works on any `tx` (owner or tenant). Either (a) add a thin auth-side `revokeSessionsForUserInTx(tx, userId)` that does the same DELETE on the owner `tx` (cleanest — keeps `eraseUser` inside the auth module), or (b) widen the existing adapter's `tx` type. Prefer (a): a small auth `session-repo`-style helper. Adjust the `EraseUserDeps.sessions` shape to whatever you implement; the unit test stubs it.

- [ ] **Step 4: Wire `defaultEraseUserDeps`**

In `src/lib/auth-deps.ts`, add:
```ts
export const defaultEraseUserDeps: EraseUserDeps = {
  users: userRepo,                 // the real UserRepo (anonymiseErasedInTx)
  sessions: authSessionRepo,       // the owner-tx session-revoke helper from Step 3
  audit: auditRepo,                // the real AuditRepo (appendInTx)
};
```
Import the real singletons that already live in `auth-deps.ts` / the auth infra (mirror `defaultDeleteInvitedUserDeps`).

- [ ] **Step 5: Run the unit test — expect PASS**

Run: `pnpm vitest run tests/unit/auth/application/erase-user.test.ts`
Expected: PASS.

- [ ] **Step 6: Barrel-export from auth**

In `src/modules/auth/index.ts`, export `eraseUser` + its types (`EraseUserInput`, `EraseUserError`, `EraseUserDeps`), matching the barrel's existing export style (so the members adapter can import from `@/modules/auth`).

- [ ] **Step 7: True typecheck + commit**

Run a true typecheck (temp tsconfig excl `.next`) → 0.
```bash
git add src/modules/auth/application/erase-user.ts src/lib/auth-deps.ts src/modules/auth/index.ts tests/unit/auth/application/erase-user.test.ts src/modules/auth/infrastructure/db/*session*.ts
git commit -m "feat(auth): eraseUser use-case — anonymise login + revoke + user_erased (COMP-1 US2a)"
```

---

## Task 4: live-Neon `eraseUser` integration — the no-login-resolvable oracle

**Files:**
- Test: `tests/integration/auth/erase-user.test.ts` (extend Task 2's file)

- [ ] **Step 1: Add the end-to-end integration case (RED→GREEN)**

Add to `tests/integration/auth/erase-user.test.ts` — exercise the real `eraseUser` (real deps) against live Neon:
```ts
import { eraseUser } from '@/modules/auth/application/erase-user';

it('after eraseUser: no login-resolvable email, sessions revoked, user_erased audit', async () => {
  const user = await seedActiveUser({ email: 'login@example.com', displayName: 'Login User' });
  await seedSession(user.id);                       // an active session row

  const res = await eraseUser({ userId: user.id, actorUserId: 'admin-it', requestId: 'it-1', sourceIp: null });
  expect(res.ok).toBe(true);

  // No row resolves by the original email (login lookup is by lower(email))
  const byOldEmail = await rawSelectUserByEmailLower('login@example.com');
  expect(byOldEmail).toBeUndefined();
  // The row is anonymised + disabled
  const row = await rawSelectUser(user.id);
  expect(row.email).toBe(`erased+${user.id}@erased.invalid`);
  expect(row.password_hash).toBeNull();
  expect(row.status).toBe('disabled');
  // Sessions gone
  const sessions = await rawSelectSessions(user.id);
  expect(sessions).toHaveLength(0);
  // user_erased audit present, no PII
  const audits = await rawSelectAuditByTarget(user.id);
  expect(audits.map((a) => a.event_type)).toContain('user_erased');
  expect(JSON.stringify(audits)).not.toContain('login@example.com');
});
```
Adapt the raw-select helpers to the auth integration suite's conventions. RED is unlikely (Tasks 2+3 built the pieces) — but author it and confirm GREEN on live Neon.

- [ ] **Step 2: Run + commit**

Run: `pnpm vitest run -c vitest.integration.config.ts tests/integration/auth/erase-user.test.ts` → green.
```bash
git add tests/integration/auth/erase-user.test.ts
git commit -m "test(auth): eraseUser live-Neon no-login-resolvable oracle (COMP-1 US2a)"
```

---

## Task 5: `UserErasurePort` + adapter (members → auth bridge)

**Files:**
- Create: `src/modules/members/application/ports/user-erasure-port.ts`
- Create: `src/modules/members/infrastructure/adapters/auth-user-erasure-adapter.ts`
- Test: covered by Task 7's eraseMember integration (the adapter is a thin pass-through)

- [ ] **Step 1: Define the port**

Create `src/modules/members/application/ports/user-erasure-port.ts`:
```ts
import type { Result } from '@/lib/result';

/**
 * COMP-1 US2a — members→auth bridge for F1 linked-user erasure. Anonymises one
 * login account (cross-tenant `users` row) in its own owner-role tx. Idempotent.
 * `erased:false` ⇒ the user row was already gone. Failure ⇒ a typed err so the
 * eraseMember cascade flips `allCascadesClean=false` and the US2d reconciler
 * re-drives it.
 */
export interface UserErasurePort {
  eraseUser(
    userId: string,
    meta: { readonly actorUserId: string; readonly requestId: string | null },
  ): Promise<Result<{ readonly erased: boolean }, { readonly code: string }>>;
}
```

- [ ] **Step 2: Implement the adapter**

Create `src/modules/members/infrastructure/adapters/auth-user-erasure-adapter.ts`:
```ts
import { eraseUser } from '@/modules/auth';            // barrel export from Task 3
import type { UserErasurePort } from '../../application/ports/user-erasure-port';

export const authUserErasureAdapter: UserErasurePort = {
  async eraseUser(userId, meta) {
    const r = await eraseUser({
      userId,
      actorUserId: meta.actorUserId,
      requestId: meta.requestId ?? 'system',
      sourceIp: null,
    });
    if (!r.ok) return { ok: false, error: { code: r.error.code } } as const;
    return { ok: true, value: { erased: r.value.erased } } as const;
  },
};
```
Match the project's `Result` constructor convention (it may export `ok`/`err` helpers — use them instead of object literals if that's the house style).

- [ ] **Step 3: True typecheck + commit**

```bash
git add src/modules/members/application/ports/user-erasure-port.ts src/modules/members/infrastructure/adapters/auth-user-erasure-adapter.ts
git commit -m "feat(members): UserErasurePort + auth adapter (COMP-1 US2a)"
```

---

## Task 6: Wire the F1 user-erasure cascade into `eraseMember`

**Files:**
- Modify: `src/modules/members/application/use-cases/erase-member.ts`
- Modify: `src/modules/members/members-deps.ts`
- Test: `tests/unit/members/application/erase-member.test.ts`, `tests/unit/members/members-deps.test.ts`

- [ ] **Step 1: Add the failing unit cases (RED)**

Add to `tests/unit/members/application/erase-member.test.ts` (read the file for the current `buildEraseDeps` fixture — add a `userErasure` stub there returning `ok({ erased: true })`, and `listLinkedUserIdsForMemberInTx` returning the linked ids):
```ts
it('erases each linked F1 user post-commit and stays clean on success', async () => {
  const deps = buildEraseDeps();
  deps.contactRepo.listLinkedUserIdsForMemberInTx = vi.fn(async () => ['u-1', 'u-2']);
  const res = await eraseMember(asMemberId('m-1'), { reason: 'gdpr_erasure_request' }, META, deps);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value.cascadesComplete).toBe(true);
  expect(deps.userErasure.eraseUser).toHaveBeenCalledWith('u-1', expect.objectContaining({ actorUserId: 'admin-1' }));
  expect(deps.userErasure.eraseUser).toHaveBeenCalledWith('u-2', expect.anything());
  const types = deps.audit.recordInTx.mock.calls.map((c) => (c[2] as { type: string }).type);
  expect(types).toContain('member_erased');
});

it('a failing F1 user-erasure blocks member_erased (reconciler re-drives)', async () => {
  const deps = buildEraseDeps();
  deps.contactRepo.listLinkedUserIdsForMemberInTx = vi.fn(async () => ['u-1']);
  deps.userErasure.eraseUser = vi.fn(async () => ({ ok: false, error: { code: 'erase-user-failed' } }));
  const res = await eraseMember(asMemberId('m-1'), { reason: 'gdpr_erasure_request' }, META, deps);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value.cascadesComplete).toBe(false);
  const types = deps.audit.recordInTx.mock.calls.map((c) => (c[2] as { type: string }).type);
  expect(types).not.toContain('member_erased');
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm vitest run tests/unit/members/application/erase-member.test.ts`
Expected: FAIL — `deps.userErasure` undefined / the cascade not wired.

- [ ] **Step 3: Add `userErasure` to `EraseMemberDeps` + surface the linked ids**

In `erase-member.ts`:
- Add to `EraseMemberDeps`: `userErasure: UserErasurePort;` (import the type).
- Surface the linked-user ids to outer scope: declare `let linkedUserIdsForErasure: string[] = [];` BEFORE `await runInTenant(...)`, and inside the atomic tx (where `uniqueLinkedUserIds` is computed for the session cascade) assign `linkedUserIdsForErasure = uniqueLinkedUserIds;`. (Do NOT re-read after the tx — the contacts are now `removed_at`-set, so a re-read returns []; reuse the in-tx snapshot, same Bug-I-1 reasoning.)

- [ ] **Step 4: Add the F1 cascade block**

In `erase-member.ts`, BETWEEN the F8 renewals `catch` block and the `// 4. Completion proof` comment, add:
```ts
  // F1 linked-user erasure (US2a) — anonymise each login account in its own
  // owner-role tx (the users table is cross-tenant; cannot join the members tx).
  // Best-effort + idempotent: any failure flips allCascadesClean so the US2d
  // reconciler re-drives. Uses the linked-user snapshot read inside the scrub tx
  // (re-reading here would return [] — contacts are now removed_at-set, Bug I-1).
  for (const userId of linkedUserIdsForErasure) {
    try {
      const r = await deps.userErasure.eraseUser(userId, {
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
      });
      if (!r.ok) {
        allCascadesClean = false;
        logger.error({ memberId, userId, requestId: meta.requestId, code: r.error.code, cascade: 'f1_user_erasure' }, 'erase-member: F1 user erasure not clean');
      }
    } catch (cascadeErr) {
      allCascadesClean = false;
      logger.error({ err: cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr), memberId, userId, requestId: meta.requestId, cascade: 'f1_user_erasure' }, 'erase-member: F1 user erasure threw');
    }
  }
```

- [ ] **Step 5: Run — expect PASS**

Run: `pnpm vitest run tests/unit/members/application/erase-member.test.ts`
Expected: PASS — both new cases + all existing (the empty-linked-ids happy path: loop is a no-op).

- [ ] **Step 6: Wire the adapter into `buildEraseMemberDeps` + the guard test**

In `members-deps.ts`, add `userErasure: authUserErasureAdapter,` to `buildEraseMemberDeps` (import the adapter). In `tests/unit/members/members-deps.test.ts`, add `userErasure` to the expected key set + (if the guard asserts reference-equality) assert it's the real adapter.

- [ ] **Step 7: True typecheck → 0; commit**

```bash
git add src/modules/members/application/use-cases/erase-member.ts src/modules/members/members-deps.ts tests/unit/members/application/erase-member.test.ts tests/unit/members/members-deps.test.ts tests/unit/members/application/erase-member.fixtures.ts
git commit -m "feat(members): wire F1 user-erasure cascade into eraseMember (COMP-1 US2a)"
```

---

## Task 7: End-to-end live-Neon — eraseMember anonymises the linked login

**Files:**
- Test: `tests/integration/members/erase-member-f1-user.test.ts` (create)

- [ ] **Step 1: Write the e2e integration test (RED→GREEN)**

Create `tests/integration/members/erase-member-f1-user.test.ts`. Reuse the seed scaffolding from `tests/integration/members/erase-member-cascade.test.ts` (it already seeds a member + a contact with `linked_user_id` + a real F1 user + a session). Use the production `buildEraseMemberDeps(ctx.tenant)`:
```ts
import { eraseMember } from '@/modules/members';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';

it('eraseMember anonymises the linked F1 login + emits user_erased', async () => {
  const { memberId, linkedUserId } = await seedMemberWithLinkedUser(ctx, { userEmail: 'member-login@example.com' });
  const deps = buildEraseMemberDeps(ctx.tenant);

  const res = await eraseMember(memberId, { reason: 'gdpr_erasure_request' }, { actorUserId: ctx.adminUserId, requestId: 'it-f1' }, deps);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value.cascadesComplete).toBe(true);

  // The linked login is anonymised — no resolution by the old email
  const userRow = await rawSelectUser(linkedUserId);
  expect(userRow.email).toBe(`erased+${linkedUserId}@erased.invalid`);
  expect(userRow.password_hash).toBeNull();
  expect(userRow.status).toBe('disabled');
  // user_erased audit + member_erased completion proof both present
  const auditTypes = await rawSelectAllAuditTypesForMemberAndUser(memberId, linkedUserId);
  expect(auditTypes).toContain('user_erased');
  expect(auditTypes).toContain('member_erased');
});
```

- [ ] **Step 2: Run it — iterate to GREEN on live Neon**

Run: `pnpm vitest run -c vitest.integration.config.ts tests/integration/members/erase-member-f1-user.test.ts`
Expected: GREEN. (If the seed helper from the cascade test doesn't expose `linkedUserId`, extend it.)

- [ ] **Step 3: Final gates**

```bash
pnpm vitest run tests/unit/auth/domain/audit-event.test.ts tests/unit/auth/application/erase-user.test.ts tests/unit/members/application/erase-member.test.ts tests/unit/members/members-deps.test.ts
pnpm vitest run -c vitest.integration.config.ts tests/integration/auth/erase-user.test.ts tests/integration/members/erase-member-f1-user.test.ts tests/integration/members/erase-member-cascade.test.ts
pnpm lint
# true typecheck via temp tsconfig excluding .next
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/members/erase-member-f1-user.test.ts
git commit -m "test(members): eraseMember F1 linked-login anonymisation e2e (COMP-1 US2a)"
```

---

## Self-Review

**1. Spec coverage (design §4 F1 "BUILD net-new" + §5 F1 row + §10 F1 oracle):**
- Anonymise `users.email` → tenant-unique (here: globally-unique) sentinel preserving the unique constraint → Task 2 ✓ (the `users` table is cross-tenant; "globally unique" is the correct realisation of "preserve the unique constraint").
- Invalidate `password_hash`, name → `[erased]` → Task 2 ✓ (+ `status='disabled'` belt-and-suspenders).
- Revoke sessions (existing hook) → Task 3 ✓ (idempotent in the owner-tx).
- New `user_erased` audit → Task 1 (4-place) + Task 3 (emit) ✓.
- Behind an auth-module port → `eraseUser` in auth/application; the members→auth bridge is `UserErasurePort` (Task 5) ✓.
- §10 oracle "no login-resolvable email + sessions revoked" → Task 4 + Task 7 ✓.
- Wired as a post-commit best-effort cascade, idempotent/resumable, flipping `cascadesComplete` → Task 6 ✓.
- ≥2 reviewers + security checklist → flagged in the header + at the handoff ✓.

**2. Placeholder scan:** the migration index is `0XXX` (resolved at Task 1 Step 6 by `ls … | tail -1` — a real instruction, not a TODO). The session-revoke dep shape (Task 3 Step 3) names two concrete options with a recommendation — the engineer picks (a); it is not a vague "handle it". All test bodies are complete.

**3. Type consistency:** `eraseUser(input, deps): Result<{erased:boolean}, {code:'erase-user-failed'}>` is used identically in Task 3 (def), Task 5 (adapter call), Task 6 (cascade). `UserErasurePort.eraseUser(userId, {actorUserId, requestId})` matches the adapter (Task 5) + the eraseMember call (Task 6 Step 4) + the fixture stub (Task 6 Step 1). `anonymiseErasedInTx(tx, userId)` is consistent Task 2 ↔ Task 3. `cascadesComplete` (not `completed`) used in Task 6 assertions.

**Scope boundary:** US2a stops at F1 user erasure. F7 content tombstone (US2b), F6 fan-out (US2c), and the reconciler + `erasure_outcome` metric (US2d) are separate plans. F8 is a documented no-op (renewals carry no denormalized member PII).

> **Design-doc follow-up (not in this plan):** the gathered context corrects three design assumptions worth folding into `2026-06-16-member-erasure-design.md` before US2b–d: F8 = no-op; F1 `users` is cross-tenant (sentinel is *globally* unique, not tenant-scoped; erasure runs in an owner-tx); F4 trigger needs no change (its GUC already covers member invoices). Update §4/§5/§9 accordingly.
