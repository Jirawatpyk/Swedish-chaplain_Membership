# Staff Invitation Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/admin/users` full control over pending invitations — resend, revoke, see expiry, and auto-prune long-dead ones — reusing F1 auth mechanisms without breaking F3 member-contact links.

**Architecture:** Application use cases wrap the existing `reissueInvitation` / repo delete primitives and emit audit at the use-case level (never inside the shared `reissueInvitation`, which F3's member-resend also calls). Thin admin-gated routes mirror the existing `disable`/`enable`/`role` routes. A native Vercel GET cron prunes. `contacts.linked_user_id` FK is `ON DELETE SET NULL`, so deleting a pending user unlinks the member contact safely.

**Tech Stack:** Next.js 16 route handlers, Drizzle + Neon Postgres (RLS), Vitest (unit + live-Neon integration), next-intl (EN/TH/SV), native Vercel Cron.

## Global Constraints

- TypeScript strict: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. No `any`.
- Clean Architecture (Principle III): routes call Application use cases only; **routes MUST NOT import `infrastructure/`** (no direct `auditRepo`). Use cases receive an audit port via deps.
- TDD: failing test → implement → green → commit. Auth is security-sensitive.
- Audit `summary` ≤ 500 chars. `actorUserId` is `ActorRef` (the acting admin's id string).
- Cron routes: `export const runtime = 'nodejs'`, GET-only, gated by `gateCronBearerOrRespond` (`@/lib/cron-auth`, `CRON_SECRET`).
- pnpm only. Run `pnpm typecheck` as the final gate. Integration tests hit the dev Neon branch (`.env.local`).
- **Already done (Task 0, do not redo):** `invitation_reissued`, `invitation_revoked`, `invitation_expired` added to the audit enum — domain tuple `src/modules/auth/domain/audit-event.ts`, pgEnum `src/modules/auth/infrastructure/db/schema.ts`, migration `drizzle/migrations/0258_staff_invitation_lifecycle_audit.sql` (+ `meta/_journal.json` idx 260), count tests `tests/unit/auth/domain/audit-event.test.ts` (36) + `tests/integration/audit/completeness.test.ts` (36). Applied to dev; 12/12 unit + 39/39 integration green.

---

## File Structure

- `src/modules/auth/application/resend-staff-invitation.ts` — **create.** Wraps `reissueInvitation`, emits `invitation_reissued`.
- `src/modules/auth/application/revoke-invitation.ts` — **create.** Deletes pending user + cleans outbox, emits `invitation_revoked`.
- `src/modules/auth/application/prune-expired-invitations.ts` — **create.** Bulk-deletes pending users expired >30d, emits `invitation_expired` per user.
- `src/modules/auth/infrastructure/db/user-repo.ts` — **modify.** Add `deletePendingInvitesExpiredBeforeInTx` (prune) + surface latest invitation `expiresAt` in `listWithFilter`; add outbox-cleanup on the delete path.
- `src/modules/auth/index.ts` — **modify.** Barrel-export the 3 new use cases + input/error types.
- `src/lib/auth-deps.ts` — **modify.** Add `defaultResendStaffInvitationDeps` / `defaultRevokeInvitationDeps` / `defaultPruneExpiredInvitationsDeps`.
- `src/app/api/auth/users/[id]/reissue-invite/route.ts` — **create.** POST, admin-gated.
- `src/app/api/auth/users/[id]/revoke-invite/route.ts` — **create.** POST, admin-gated.
- `src/app/api/cron/auth/prune-expired-invitations/route.ts` — **create.** GET, cron-gated.
- `vercel.json` — **modify.** Add the prune cron entry.
- `src/app/(staff)/admin/users/page.tsx` — **modify.** Thread `invitationExpiresAt` into the row props.
- `src/components/auth/user-list-table.tsx` — **modify.** Resend + Revoke actions on pending rows; expiry label; revoke confirm dialog.
- `src/i18n/messages/{en,th,sv}.json` — **modify.** New `admin.users.*` keys.
- Tests co-located under `tests/unit/auth/application/`, `tests/contract/auth/`, `tests/integration/auth/`.

---

## Task 1: `resendStaffInvitation` use case

**Files:**
- Create: `src/modules/auth/application/resend-staff-invitation.ts`
- Modify: `src/modules/auth/index.ts`, `src/lib/auth-deps.ts`
- Test: `tests/unit/auth/application/resend-staff-invitation.test.ts`

**Interfaces:**
- Consumes: `reissueInvitation(input, deps): Promise<Result<{invitationId, email, role}, ReissueInvitationError>>`; `AuditPort.append({eventType, actorUserId, targetUserId, summary, requestId, sourceIp})`.
- Produces:
  ```ts
  export interface ResendStaffInvitationInput {
    readonly userId: UserId;
    readonly actorUserId: UserId;
    readonly sourceIp: string;
    readonly requestId: string;
    readonly locale?: EmailLocale | undefined;
    readonly tenantId: TenantSlug;
  }
  export type ResendStaffInvitationError =
    | { code: 'user-not-found' } | { code: 'not-pending' } | { code: 'reissue-failed' };
  export function resendStaffInvitation(
    input: ResendStaffInvitationInput, deps?: ResendStaffInvitationDeps,
  ): Promise<Result<{ email: string }, ResendStaffInvitationError>>;
  ```

- [ ] **Step 1: Write failing test** — `tests/unit/auth/application/resend-staff-invitation.test.ts`. Mock `reissueInvitation` (returns `ok({invitationId, email:'a@b.co', role:'admin'})`) + a spy `audit.append`. Assert: on success the use case returns `ok({email:'a@b.co'})` AND `audit.append` was called once with `eventType:'invitation_reissued'`, `actorUserId: input.actorUserId`, `targetUserId: input.userId`. Second test: `reissueInvitation` returns `err({code:'not-pending'})` → use case returns `err({code:'not-pending'})` AND `audit.append` NOT called. Third: `err({code:'user-not-found'})` maps through.
- [ ] **Step 2: Run test, verify FAIL** — `pnpm vitest run tests/unit/auth/application/resend-staff-invitation.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** — new use case: call `reissueInvitation({userId, invitedByUserId: actorUserId, locale, tenantId, requestId}, deps.reissue)`. On `err`, map `user-not-found`/`not-pending` straight through, everything else → `reissue-failed`, return without auditing. On `ok`, `await deps.audit.append({eventType:'invitation_reissued', actorUserId, targetUserId:userId, sourceIp, requestId, summary:\`invitation reissued for ${result.value.email}\`})`, return `ok({email})`. Add `ResendStaffInvitationDeps { reissue: typeof reissueInvitation; audit: Pick<AuditRepo,'append'> }` + `defaultResendStaffInvitationDeps` in `auth-deps.ts`. Barrel-export from `index.ts`.
- [ ] **Step 4: Run test, verify PASS.**
- [ ] **Step 5: `pnpm typecheck`; commit** — `feat(auth): resendStaffInvitation use case (invitation_reissued audit)`.

## Task 2: `POST /api/auth/users/[id]/reissue-invite`

**Files:**
- Create: `src/app/api/auth/users/[id]/reissue-invite/route.ts`
- Test: `tests/contract/auth/reissue-invite-route.test.ts`

**Interfaces:** Consumes `resendStaffInvitation`, `asUserId`, `requireAdminContext`, `resolveTenantFromRequest`. Mirror `src/app/api/auth/users/[id]/disable/route.ts` exactly (structure, outer try/catch, error switch).

- [ ] **Step 1: Failing contract test** — mock `@/modules/auth` `resendStaffInvitation`. Cases: admin + ok → 200 `{ok:true}`; `not-pending` → 409; `user-not-found` → 404; unauthenticated → 401 (mock `requireAdminContext` returns `{response}`). Mirror `tests/contract/plans/palette-search.test.ts` mock style.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement route** — copy `disable/route.ts`; swap `disableUser` → `resendStaffInvitation({userId: asUserId(id), actorUserId: ctx.current.user.id, sourceIp: ctx.sourceIp, requestId: ctx.requestId, locale: resolveLocaleFromRequest(request), tenantId: resolveTenantFromRequest(request).slug})`. Error switch: `not-pending`→409, `user-not-found`→404, default→500.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: `pnpm typecheck`; commit** — `feat(auth): reissue-invite route`.

## Task 3: `revokeInvitation` use case + repo outbox cleanup

**Files:**
- Create: `src/modules/auth/application/revoke-invitation.ts`
- Modify: `src/modules/auth/infrastructure/db/user-repo.ts` (add `deletePendingInvitesOutboxForUserInTx(tx, userId): Promise<void>` — delete `notifications_outbox` rows for this user's undispatched `member_invitation` emails), `index.ts`, `auth-deps.ts`
- Test: `tests/unit/auth/application/revoke-invitation.test.ts`, `tests/integration/auth/revoke-invitation.integration.test.ts`

**Interfaces:**
```ts
export interface RevokeInvitationInput { userId: UserId; actorUserId: UserId; sourceIp: string; requestId: string; targetEmail?: string; }
export type RevokeInvitationError = { code: 'not-pending-or-not-found' };
export function revokeInvitation(input, deps?): Promise<Result<{ deleted: true }, RevokeInvitationError>>;
```
Deps: `{ users: Pick<UserRepo,'deleteInvitedPendingInTx'|'deletePendingInvitesOutboxForUserInTx'>, audit: Pick<AuditRepo,'appendInTx'>, runTx }`. Use `db.transaction` so delete + outbox-clean + audit are atomic.

- [ ] **Step 1: Failing unit test** — mock repo `deleteInvitedPendingInTx` returns `{deleted:1}` → use case returns `ok({deleted:true})` + `audit.appendInTx` called with `invitation_revoked`. `{deleted:0}` (already active/absent) → `err({code:'not-pending-or-not-found'})` + no audit.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — in a tx: `const {deleted} = await deps.users.deleteInvitedPendingInTx(tx, userId)`; if 0 → throw TxAbort err; else `await deps.users.deletePendingInvitesOutboxForUserInTx(tx, userId)` then `await deps.audit.appendInTx(tx, {eventType:'invitation_revoked', actorUserId, targetUserId:userId, sourceIp, requestId, summary:\`invitation revoked for ${targetEmail ?? userId}\`})`. Implement the repo method (DELETE from `notifications_outbox` WHERE the invitation row maps to userId AND not yet dispatched — confirm the outbox→user linkage column while implementing; if only email-linked, delete by the user's email).
- [ ] **Step 4: Run unit, verify PASS.**
- [ ] **Step 5: Integration test** — `tests/integration/auth/revoke-invitation.integration.test.ts`: seed a member + contact linked to a pending invited user (mirror `tests/integration/members/invite-portal-orphan-fix.test.ts` setup). Call `revokeInvitation`. Assert: the `users` row is gone; the `contacts` row still exists with `linked_user_id IS NULL`; an `invitation_revoked` audit row exists. Run `pnpm test:integration tests/integration/auth/revoke-invitation.integration.test.ts` → PASS.
- [ ] **Step 6: `pnpm typecheck`; commit** — `feat(auth): revokeInvitation use case (F3-safe SET NULL unlink)`.

## Task 4: `POST /api/auth/users/[id]/revoke-invite`

**Files:** Create `src/app/api/auth/users/[id]/revoke-invite/route.ts`; Test `tests/contract/auth/revoke-invite-route.test.ts`.

- [ ] **Step 1: Failing contract test** — admin + ok → 200 `{ok:true}`; `not-pending-or-not-found` → 404; unauth → 401.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — mirror `disable/route.ts`; call `revokeInvitation({userId: asUserId(id), actorUserId: ctx.current.user.id, sourceIp: ctx.sourceIp, requestId: ctx.requestId})`. `not-pending-or-not-found`→404, default→500.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: `pnpm typecheck`; commit** — `feat(auth): revoke-invite route`.

## Task 5: Expiry visibility in `listWithFilter` + table

**Files:** Modify `src/modules/auth/infrastructure/db/user-repo.ts` (`listWithFilter` LEFT JOINs the latest non-consumed invitation, returns `invitationExpiresAt: Date | null`), `src/app/(staff)/admin/users/page.tsx` (pass it through), `src/components/auth/user-list-table.tsx` (render). Test: `tests/integration/auth/list-users-expiry.integration.test.ts`.

- [ ] **Step 1: Failing integration test** — seed a pending user with an invitation `expires_at`. Assert `listWithFilter` row has `invitationExpiresAt` equal to it; an active user has `null`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — add the LEFT JOIN LATERAL (latest invitation by `created_at`, `consumed_at IS NULL`) selecting `expires_at`; add to the return type. Thread `invitationExpiresAt` through `page.tsx` row map. In `user-list-table.tsx`, for `pending` rows render `t('invite.expiresIn',{days})` or `t('invite.expired')` computed from `invitationExpiresAt` vs now.
- [ ] **Step 4: Run integration, verify PASS.**
- [ ] **Step 5: `pnpm typecheck`; commit** — `feat(admin): show invitation expiry on the users table`.

## Task 6: `pruneExpiredInvitations` use case

**Files:** Create `src/modules/auth/application/prune-expired-invitations.ts`; Modify `user-repo.ts` (`deletePendingInvitesExpiredBeforeInTx(tx, cutoff): Promise<Array<{userId, email}>>` — delete pending users whose latest invitation `expires_at < cutoff`, RETURNING id+email), `index.ts`, `auth-deps.ts`. Test: `tests/unit/...` + `tests/integration/auth/prune-expired-invitations.integration.test.ts`.

**Interfaces:**
```ts
export interface PruneExpiredInvitationsInput { now: Date; graceDays?: number; requestId: string; }
export function pruneExpiredInvitations(input, deps?): Promise<Result<{ prunedCount: number }, never>>;
```

- [ ] **Step 1: Failing integration test** — seed 3 pending users: invite expired 40d ago, expired 10d ago, live. Call `pruneExpiredInvitations({now, graceDays:30, requestId})`. Assert `prunedCount === 1`; only the 40d one is deleted; an `invitation_expired` audit row exists for it; the 10d + live users remain.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — cutoff = `now - graceDays*86400000` (default 30). In a tx: `const pruned = await deps.users.deletePendingInvitesExpiredBeforeInTx(tx, cutoff)`; for each, `await deps.audit.appendInTx(tx, {eventType:'invitation_expired', actorUserId:'system:cron', targetUserId: p.userId, summary:\`pending invite pruned (expired >${graceDays}d) for ${p.email}\`, requestId})`. Return `ok({prunedCount: pruned.length})`.
- [ ] **Step 4: Run integration, verify PASS.**
- [ ] **Step 5: `pnpm typecheck`; commit** — `feat(auth): pruneExpiredInvitations use case (30d grace)`.

## Task 7: Prune cron route + vercel.json

**Files:** Create `src/app/api/cron/auth/prune-expired-invitations/route.ts`; Modify `vercel.json`. Test: `tests/contract/auth/prune-cron-route.test.ts`.

- [ ] **Step 1: Failing contract test** — no/invalid bearer → 401 (mock `gateCronBearerOrRespond` returns a 401 response); valid → 200 `{prunedCount:N}` (mock `pruneExpiredInvitations`). Mirror `tests/contract` for an existing cron.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — copy `src/app/api/cron/renewals/prune-consumed-tokens/route.ts` shape: `export const runtime='nodejs'`, `GET`, `const gate = await gateCronBearerOrRespond(request); if (gate) return gate;` then `await pruneExpiredInvitations({now:new Date(), graceDays:30, requestId})` → `NextResponse.json({prunedCount})`. Add to `vercel.json` crons: `{ "path": "/api/cron/auth/prune-expired-invitations", "schedule": "30 4 * * *" }` (daily, off-peak, UTC — no conflict with existing entries).
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: `pnpm typecheck`; commit** — `feat(auth): prune-expired-invitations cron`.

## Task 8: user-list-table Resend + Revoke actions

**Files:** Modify `src/components/auth/user-list-table.tsx`. Test: extend `tests/unit/...` component test if present, else a focused render test.

- [ ] **Step 1: Failing test** — render a `pending` row → "Resend invitation" + "Revoke" actions present (admin); render `active`/`disabled` rows → those actions absent. Non-admin → absent.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — extend `PendingAction` union with `{kind:'revoke', user}`. Add `handleResend` (POST `/api/auth/users/${id}/reissue-invite`, toast `t('toast.resent')`, `router.refresh()`) + `handleRevoke` (POST `.../revoke-invite`, toast `t('toast.revoked')`). Show both only when `isAdmin && user.status === 'pending'`. Route Revoke through the existing confirm-dialog (`destructive`, `t('confirm.revoke.*')`). Resend fires directly (non-destructive) with a busy state.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: `pnpm typecheck`; commit** — `feat(admin): resend + revoke actions on the users table`.

## Task 9: i18n EN/TH/SV + gates + PR

**Files:** Modify `src/i18n/messages/{en,th,sv}.json`. No new test — this task is the release gate.

- [ ] **Step 1: Add keys** to all three locales (EN canonical): `admin.users.actions.resend`, `.revoke`; `admin.users.confirm.revoke.{title,description,confirm}`; `admin.users.toast.{resent,revoked}`; `admin.users.invite.{expiresIn,expired}`. TH + SV translated (not EN fallback).
- [ ] **Step 2: `pnpm check:i18n`** → passes (no missing EN; TH/SV present).
- [ ] **Step 3: Full gates** — `pnpm lint && pnpm typecheck && pnpm vitest run && pnpm check:audit-events && pnpm check:audit-counts && pnpm check:i18n`, then `pnpm test:integration tests/integration/auth/` + `tests/integration/audit/completeness.test.ts`. All green.
- [ ] **Step 4: Commit + PR** — push branch `staff-invitation-lifecycle`; open PR against `main` with the design-doc summary + the F3-safety note + "auth surface → security reviewer" flag. Note migration 0258 already applied to dev; prod auto-migrates on deploy.

---

## Self-Review

**Spec coverage:** A(Resend)=T1+T2 · B(Revoke)=T3+T4 · C(Expiry)=T5 · D(Prune)=T6+T7 · E(UI)=T8 · F(i18n+gates)=T9 · audit foundation=T0(done). All design sections covered.

**Placeholder scan:** One deferred detail — the exact `notifications_outbox`→user linkage column in T3 Step 3 (delete-by-userId vs delete-by-email). Flagged as a build-time confirm, not a silent TODO; the test asserts the outcome either way.

**Type consistency:** `UserId`/`TenantSlug`/`EmailLocale` used consistently; `resendStaffInvitation`→`{email}`, `revokeInvitation`→`{deleted:true}`, `pruneExpiredInvitations`→`{prunedCount}`; audit event literals match the Task 0 enum exactly (`invitation_reissued`/`invitation_revoked`/`invitation_expired`).

---

## Review Amendments (2026-07-17 — architecture + security review)

These OVERRIDE the tasks above where they conflict. Scope decision: **Revoke/Prune cover ALL roles including member-linked pending users (Path B)**; a small F3 read-side fix (Task 10) prevents a stale bounce badge; the member-timeline gap (auth-level revoke/prune of a member-linked user does not emit a member-scoped timeline event) is an **accepted, documented limitation** — the acting principal + target are still audited.

**RA-1 (Task 2, security HIGH) — resend rate-limit.** Before calling `resendStaffInvitation`, throttle in the route: `const rl = await rateLimiter.limit(\`reissue-invite:${tenantId}:${id}\`); if (!rl.success) return 429 with Retry-After`. Key is per-`(tenant, TARGET userId)` NOT per-admin (DV-11: else N admins collectively mail-bomb). Budget **3 / hour**. Mirror `src/app/api/members/[memberId]/contacts/[contactId]/resend-verification/route.ts:55-73`. Add a contract test: 4th call within the window → 429.

**RA-2 (Task 3 + Task 6) — outbox cleanup by EMAIL, tenant-scoped, read-before-delete.** `notifications_outbox` has **no `user_id`** (schema.ts:910). Repo method becomes `deleteInvitedPendingInTx(tx, userId): Promise<{ deleted: number; email: string | null }>` (add `.returning({ id, email })`), and a separate dep `deleteInviteOutboxByEmailInTx(tx, email, tenantId): Promise<void>` running `DELETE FROM notifications_outbox WHERE lower(to_email)=lower($email) AND notification_type='member_invitation' AND status='pending' AND tenant_id=$tenantId`. `revokeInvitation` captures the email from the delete's RETURNING and passes it + `tenantId` onward. Add `tenantId: TenantSlug` to `RevokeInvitationInput` (route supplies `resolveTenantFromRequest(request).slug`). **Prune** returns `{userId, email}[]` and loops the same outbox delete per user.

**RA-3 (Task 3 + Task 6, Principle I blocker) — cross-tenant integration test.** revoke/prune run on the owner-role tx (BYPASSRLS) touching FORCE-RLS `notifications_outbox`. Add an integration test: seed the SAME email as a pending `member_invitation` outbox row in tenant A AND tenant B; revoke the tenant-A user; assert tenant B's outbox row survives. Also assert outbox scoping: a non-`member_invitation` outbox row on the same email survives.

**RA-4 (Task 6) — prune must not delete a just-resent user (two-token).** Resend mints a NEW invitation without deleting the old, so a pending user can have both an expired and a fresh token. Prune deletes a pending user only when `NOT EXISTS (SELECT 1 FROM invitations i WHERE i.user_id = users.id AND i.expires_at >= $cutoff AND i.consumed_at IS NULL)`. Test: seed a user with an old-expired invite + a fresh invite → assert NOT pruned.

**RA-5 (Task 7) — cron convention.** Use `export const runtime='nodejs'` + `export const dynamic='force-dynamic'`; implement in `POST` and `export const GET = POST`. Gate: `const gate = await gateCronBearerOrRespond(request, { route: '/api/cron/auth/prune-expired-invitations' }); if (gate) return gate;`. **READ_ONLY_MODE short-circuit** (GET is not caught by the proxy write-freeze): `if (env.flags.readOnlyMode) return NextResponse.json({ skipped: true, reason: 'read_only_mode' }, { status: 200 });`. Mirror `prune-consumed-tokens/route.ts:45-94`. Add a test for the READ_ONLY_MODE skip.

**RA-6 (Task 2) — locale.** `resolveLocaleFromRequest` does not exist. Pass `locale: undefined` to `resendStaffInvitation` (default English; `ReissueInvitationInput.locale` is optional). Do NOT invent a helper.

**RA-7 (Task 5) — projection type.** `listWithFilter` returns `UserListRow = UserAccount & { invitationExpiresAt: Date | null }` — do NOT add the field to the `UserAccount` domain type.

**RA-8 (Task 1) — audit non-atomicity accepted.** `reissueInvitation` owns its own tx, so `resendStaffInvitation` calls `audit.append` (non-tx) AFTER it commits — matches F3's `member_portal_invite_queued` pattern. Document as an accepted edge (a post-commit audit-append failure leaves a reissued invite without its `invitation_reissued` row). revoke/prune stay atomic via `appendInTx`.

### Task 10: F3 stale-bounce read-side fix

**Files:** Modify the contact-directory read that computes the "invite bounced" badge (`src/modules/members/infrastructure/db/drizzle-contact-repo.ts` / `drizzle-member-repo.ts` — grep `invite_bounced_at`). Test: extend the relevant F3 integration test.

- [ ] **Step 1: Failing test** — seed a contact with `invite_bounced_at` set AND `linked_user_id IS NULL` (the post-revoke state). Assert the directory row's `inviteBounced` (or equivalent) is `false`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — in the badge projection, treat `invite_bounced_at` as meaningful only when `linked_user_id IS NOT NULL` (`inviteBounced = invite_bounced_at IS NOT NULL AND linked_user_id IS NOT NULL`). Self-heals after a staff revoke/prune SET-NULLs the link.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: `pnpm typecheck`; commit** — `fix(members): bounce badge is meaningful only while a user is linked`.

### Test gaps to add (fold into the owning tasks)
- Cross-tenant outbox isolation (RA-3) — Task 3.
- Resend rate-limit 429 + per-target keying (RA-1) — Task 2.
- READ_ONLY_MODE prune skip (RA-5) — Task 7.
- Throw-path atomicity (outbox delete throws mid-tx → user-delete + audit roll back) — Task 3, live-Neon.
- Prune two-token protection (RA-4) — Task 6.
