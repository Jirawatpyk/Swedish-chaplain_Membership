# Path C Implementation Plan — F1 createUser Atomicity (in-PR #6)

**Date**: 2026-04-17
**Scope decision**: Bundle F1 atomic refactor into PR #6 (not separate PR #7)
**Status**: PLANNING — awaiting explicit execution confirmation
**Estimated effort**: 2-3 hours
**Risk level**: 🔴 HIGH (F1 core auth touched)

---

## Context

After 4 full-F3 staff reviews + ship of PR #6, user elected to bundle F1 `createUser` atomicity fix into the same PR rather than defer to PR #7. This plan documents the scope, execution sequence, and verification gates before touching F1.

**Why this exists**: T049 migrated F1 invitation email from synchronous Resend send → `notifications_outbox` enqueue. Admin-visible silent-success still possible if outbox insert fails after user + invitation rows commit. L1-L3 observability (metrics + stuck detection + badge) mitigates but does not eliminate. Path C eliminates structurally via `db.transaction(...)`.

---

## Pre-Flight — Clean Pending State

X1a compensating cascade was partially written in the previous turn:
- `src/modules/auth/application/create-user.ts` — modified (pending revert)
- `tests/unit/auth/application/create-user.test.ts` — modified (pending revert)

**First action**: `git checkout src/modules/auth/application/create-user.ts tests/unit/auth/application/create-user.test.ts`

These X1a changes are incompatible with Path C (compensating logic is redundant when `db.transaction` handles rollback via throw).

---

## Phase 1 — F1 Repo InTx Variants (60 min)

### 1.1 `UserRepo` port + `drizzle-user-repo.ts`

Add 2 new methods that accept `tx`:
```ts
findByEmailInTx(tx: DbTx, email: EmailAddress):
  Promise<{ user: UserAccount; passwordHash: PasswordHash | null } | null>;

createPendingInTx(tx: DbTx, args: {
  email: EmailAddress;
  role: Role;
  displayName?: string | null;
}): Promise<UserAccount>;
```

Existing non-`InTx` variants remain (sign-in + other flows still use them). Only `createUser` migrates.

### 1.2 `TokenRepo` port + `drizzle-token-repo.ts`

Add 1 new method:
```ts
createInvitationInTx(tx: DbTx, args: {
  userId: UserId;
  invitedByUserId: UserId;
  intendedRole: Role;
  now: Date;
}): Promise<Invitation>;
```

### 1.3 `AuditRepo` port + `drizzle-audit-repo.ts`

Add 1 new method:
```ts
appendInTx(tx: DbTx, event: AuditEvent): Promise<void>;
```

### 1.4 `enqueueInvitationInTx` in `auth-deps.ts`

Add tx-accepting variant alongside existing `enqueueInvitation`:
```ts
export const enqueueInvitationInTx: EnqueueInvitationInTxFn = async (tx, req) => {
  try {
    const [row] = await tx.insert(notificationsOutbox).values({...}).returning({ id: notificationsOutbox.id });
    if (!row) return err({ code: 'no_row_returned' });
    return ok({ outboxRowId: row.id });
  } catch (e) {
    return err({ code: 'enqueue_failed', cause: e instanceof Error ? e.message : String(e) });
  }
};
```

### 1.5 `CreateUserAbort<E>` sentinel

New file: `src/modules/auth/application/tx-abort.ts` (mirrors F3 `UseCaseAbort`):
```ts
export class CreateUserAbort<E> extends Error {
  constructor(public readonly error: E) {
    super();
    this.name = 'CreateUserAbort';
  }
}
```

### 1.6 Type export for `DbTx`

Expose Drizzle tx type from `src/lib/db.ts` (already done — `TenantTx` exists; need a non-tenant-scoped equivalent `DbTx` or reuse `TenantTx` since tx shape is identical):

**Decision**: export `DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0]` as a peer to existing `TenantTx`.

---

## Phase 2 — create-user.ts Rewrite (30 min)

### Before (current)
```ts
export async function createUser(input, deps) {
  // 1. validate
  // 2. dup check (tx 1 — separate)
  // 3. createPending (tx 2)
  // 4. createInvitation (tx 3) + compensating deletePending on fail
  // 5. enqueueInvitation (tx 4) — LOG ONLY on fail (W1 metric)
  // 6. audit.append (tx 5)
  // 7. authMetrics.invitationSent
}
```

### After (Path C)
```ts
export async function createUser(input, deps) {
  // Pre-tx: input validation
  const emailVo = asEmailAddress(input.email);
  if (!emailVo.ok) return err({ code: 'invalid-input' });

  try {
    const { user, invitation } = await db.transaction(async (tx) => {
      // 1. Dup check inside tx (prevents TOCTOU race)
      const existing = await deps.users.findByEmailInTx(tx, emailVo.value);
      if (existing) throw new CreateUserAbort({ code: 'email-taken' });

      // 2. Create user
      const user = await deps.users.createPendingInTx(tx, {
        email: emailVo.value,
        role: input.role,
        displayName: input.displayName ?? null,
      });

      // 3. Create invitation
      const now = deps.now();
      const invitation = await deps.tokens.createInvitationInTx(tx, {
        userId: user.id,
        invitedByUserId: input.actorUserId,
        intendedRole: input.role,
        now,
      });

      // 4. Enqueue outbox — ATOMIC with steps 1-3
      const enqueue = await deps.enqueueInvitationInTx(tx, {
        toEmail: user.email,
        token: invitation.id,
        role: input.role,
        locale: input.locale,
      });
      if (!enqueue.ok) {
        throw new CreateUserAbort({
          code: 'invitation-create-failed',
          cause: enqueue.error,
        });
      }

      // 5. Audit
      await deps.audit.appendInTx(tx, {
        eventType: 'account_created',
        actorUserId: input.actorUserId,
        targetUserId: user.id,
        sourceIp: input.sourceIp,
        summary: `invited ${input.role} ${user.email}`,
        requestId: input.requestId,
      });

      return { user, invitation };
    });

    // Post-tx: metric emission (outside tx boundary)
    authMetrics.invitationSent(input.role);
    return ok({ user, invitationId: invitation.id });
  } catch (e) {
    if (e instanceof CreateUserAbort) {
      const err0 = e.error;
      if (err0.code === 'invitation-create-failed') {
        // Audit the compensating rollback for observability
        logger.error(
          {
            requestId: input.requestId,
            errCause: err0.cause,
          },
          'create_user.invitation_create_failed_tx_rolled_back',
        );
        authMetrics.invitationEnqueueFailed(input.role, 'enqueue_failed');
      }
      return err(err0);
    }
    throw e;
  }
}
```

### Changes
- Remove compensating `deletePending` logic (tx handles rollback automatically)
- Remove standalone `authMetrics.invitationEnqueueFailed` on log-only path (now fires in catch block)
- `invitationSent` metric moves to post-commit (only success flows)

---

## Phase 3 — Test Updates (40 min)

### 3.1 `create-user.test.ts` unit test rewrite

Mock `db.transaction` to invoke callback with fake tx:
```ts
vi.mock('@/lib/db', () => ({
  db: {
    transaction: vi.fn(async (fn) => fn({ /* fake tx */ })),
  },
}));
```

Test matrix (replace 7 existing tests):
1. Happy path — all steps ok → `ok({ user, invitationId })` + `authMetrics.invitationSent` called
2. `invalid-input` — email validation fails before tx
3. `email-taken` — `findByEmailInTx` returns existing → `CreateUserAbort` → `err`
4. `invitation-create-failed` via invitation throw — rollback, no audit
5. `invitation-create-failed` via enqueue `err` — `CreateUserAbort` → compensating log + metric + `err`
6. Generic tx error (e.g., user create throws) — rethrown (not wrapped in `CreateUserAbort`)
7. Locale passthrough — `th` propagated to `enqueueInvitationInTx`

### 3.2 F1 integration regression

Run full F1 test suites to catch any cross-impact:
- `tests/integration/auth/account-lifecycle.test.ts` — must pass (uses `createUser` via `invitePortal`)
- `tests/integration/auth/last-admin-protection.test.ts` — stub shape changes needed (add `InTx` methods)

### 3.3 F3 integration regression

- `tests/integration/members/outbox-member-invitation.test.ts` — F1 createUser outbox shape (2 tests) — should still pass, now with true atomicity guarantee
- `tests/integration/members/outbox-permanent-failure.test.ts` — admin resend flow

---

## Phase 4 — Option B (25 min)

### 4.1 ESLint rule extension

File: `eslint.config.mjs` lines 82-100 (Application-layer rule)

Current rule blocks **package names** (`drizzle-orm`, `next`, `react`). Need to also block **path patterns** that leak Infrastructure:

```js
{
  files: ["src/modules/**/application/**/*.ts", "src/modules/**/application/**/*.tsx"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: applicationForbiddenImports.map(...),
        patterns: [
          {
            group: [
              "@/modules/*/infrastructure/**",
              "../infrastructure/**",
              "../../infrastructure/**",
            ],
            message: "Application must not import Infrastructure directly. Define a Port interface in application/ports/ and inject the Infrastructure adapter via composition root (src/lib/auth-deps.ts or members-deps.ts).",
          },
        ],
      },
    ],
  },
},
```

### 4.2 Migration 0018 — outbox permanent-failed index

File: `drizzle/migrations/0018_outbox_permanent_updated_idx.sql`

```sql
-- Index to back OutboxHealthBadge permanent-failed lookup (§ 15.1 L3).
-- WHERE status = 'permanently_failed' AND updated_at >= NOW() - INTERVAL '24 hours'
-- Partial index keeps size small (only the permanently_failed subset).
CREATE INDEX "outbox_permanent_updated_idx"
  ON "notifications_outbox" ("status", "updated_at")
  WHERE "status" = 'permanently_failed';
```

Schema update: add matching `.index()` declaration in `src/modules/auth/infrastructure/db/schema.ts` notificationsOutbox table.

---

## Phase 5 — Verification (30 min)

### 5.1 Static gates
```bash
pnpm typecheck   # expect clean
pnpm lint        # expect clean
pnpm check:i18n  # expect 725 × 3 locales (unchanged)
```

### 5.2 F1 regression suite
```bash
pnpm test tests/unit/auth/           # ~200 tests
pnpm test:integration tests/integration/auth/  # ~50 tests on live Neon
```

Must be 100% green. Any red → stop + revert.

### 5.3 F3 regression suite
```bash
pnpm test tests/unit/members/        # 244 tests
pnpm test:integration tests/integration/members/  # 123 tests
```

Must be 100% green.

### 5.4 Apply migration 0018
```bash
pnpm drizzle-kit migrate
```

Verify index exists:
```sql
SELECT indexname FROM pg_indexes WHERE tablename = 'notifications_outbox';
```

---

## Phase 6 — Commit + Push (10 min)

Commits (in order):
1. `chore(eslint): block Application → Infrastructure path imports (Principle III hardening)`
2. `refactor(f1): atomic createUser via db.transaction — eliminates enqueue silent-success`
3. `feat(db): migration 0018 — outbox permanent-failed index for OutboxHealthBadge`
4. `docs(observability): update § 15.1 — silent-success closed by F1 atomic refactor`

Push to `origin/005-members-contacts` → updates PR #6.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| F1 test regression | 🟡 Medium | 🔴 High | Full F1 suite gate in Phase 5.2 |
| `db.transaction` not exported correctly | 🟢 Low | 🟡 Medium | Use existing `TenantTx` pattern |
| Test stub shape drift | 🟡 Medium | 🟢 Low | Fix-forward when found |
| Reviewer asks "why F1 in F3 PR?" | 🔴 High | 🟡 Medium | PR description update explaining atomicity elimination |
| Migration 0018 fails on prod data | 🟢 Low | 🔴 High | Partial index + idempotent CREATE |
| Reset of 4-round review cycle | 🔴 High | 🟡 Medium | Expected cost of bundling F1 in F3 PR |

---

## Decision Gates

### ✅ GO signals (user must confirm each)

1. **X1a revert OK?** Discards 2 files of work that are incompatible with true atomic approach.
2. **F1 refactor in F3 PR OK?** Bundles F1 atomicity into a PR titled "F3" — reviewer will need context.
3. **Review cycle reset OK?** Round 5 staff review needed after F1 changes land.
4. **2-3 hour delay on ship OK?** F3 is currently ship-ready as PR #6; Path C delays merge.

### ❌ STOP signals

- Any F1 test regression in Phase 5.2 → halt, revert, switch to Path B (X1a + Option B only)
- `db.transaction` export shape surprises → halt, investigate, possibly defer to PR #7

---

## Alternative: Path B Recap

If any GO signal is NO:
1. Revert Path C plan
2. Re-apply X1a compensating cascade (pragmatic silent-success closure)
3. Apply Option B (ESLint + migration 0018)
4. Commit + push to PR #6 (no review cycle reset — smaller diff)
5. File F1 atomic refactor as follow-up ticket for PR #7

**Effort**: 45 min vs 3 hr
**Risk**: 🟢 Low vs 🔴 High

---

## Next Step

**User must confirm all 4 GO signals before I start Phase 1.**

If confirmed: execute Phases 1-6 sequentially with verification gates.
If not: fall back to Path B (pragmatic X1a + Option B).
