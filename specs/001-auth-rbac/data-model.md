# Phase 1 — Data Model: F1 Auth & RBAC

**Feature**: 001-auth-rbac
**Date**: 2026-04-09
**Sources**: [spec.md](./spec.md) § Key Entities, [research.md](./research.md) § 4, § 5, § 7

This document is the authoritative domain + persistence model for F1. It is
**framework-agnostic** down to the SQL schema section — the Domain types named
below live in `src/modules/auth/domain/` with zero Drizzle/Next.js imports.
The SQL (§ 7) lives in `src/modules/auth/infrastructure/db/schema.ts`.

---

## 1. Entities overview

| Entity | Purpose | Lifetime | Mutability |
|---|---|---|---|
| `UserAccount` | A set of credentials that can sign in | Permanent (soft-disabled) | Mutable (status, last-seen, failed-count) |
| `Session` | An active authenticated presence | Transient (30 min idle / 12 h absolute) | Mutable (`last_seen_at` only) |
| `PasswordResetToken` | Short-lived single-use recovery artefact | 1 hour | Single-use, then consumed |
| `Invitation` | Short-lived single-use account-creation artefact | 7 days | Single-use, then consumed |
| `AuditEvent` | Append-only authentication event record | ≥ 5 years | **Immutable** |

The `Role` concept is modelled as a string enum (not a table) — see § 2.

---

## 2. Domain types (`src/modules/auth/domain/`)

### 2.1 `Role`

```ts
// src/modules/auth/domain/role.ts
export const ROLES = ['admin', 'manager', 'member'] as const;
export type Role = (typeof ROLES)[number];

export const STAFF_ROLES: readonly Role[] = ['admin', 'manager'];
export const PORTAL_FOR_ROLE: Record<Role, 'staff' | 'member'> = {
  admin: 'staff',
  manager: 'staff',
  member: 'member',
};
```

### 2.2 `UserStatus`

```ts
// src/modules/auth/domain/user.ts
export const USER_STATUSES = ['pending', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
```

**Allowed transitions** (enforced in `application/` layer use cases):

```
 (create)──▶ pending ──(redeem invite)──▶ active ──(disable)──▶ disabled
                 │                            ▲                     │
                 │                            │                     │
                 └──(cancel invite)──▶ ──(re-enable)────────────────┘
                                                ▲
                                                │
                                    (admin reactivates)
```

- `pending → active`: only via `redeem-invite` use case (password is set during
  the transition).
- `active → disabled`: admin action (`disable-user` use case).
- `disabled → active`: admin action (`enable-user` use case).
- `pending → (deleted)`: invitation expires after 7 days AND the operator
  cancels; out of F1 scope — for F1 the pending row stays forever if not
  redeemed, but cannot be reused (`redeem-invite` rejects expired tokens).

**Lockout** is **NOT** a status — it is a `failed_signin_count` + `locked_until`
pair on the `active` user. A locked `active` user is still `active`; they
simply cannot sign in until `locked_until < now()`. This keeps the state
machine small (3 states) and avoids conflating security-driven temporary
blocks with admin-driven permanent disables.

### 2.3 `UserAccount`

```ts
// src/modules/auth/domain/user.ts
export interface UserAccount {
  readonly id: UserId;                     // branded type over string (UUID v7)
  readonly email: EmailAddress;            // branded, normalised to lowercase
  readonly role: Role;
  readonly status: UserStatus;
  readonly createdAt: Date;                // UTC
  readonly lastSignInAt: Date | null;
  readonly lastPasswordChangedAt: Date | null;
  readonly failedSignInCount: number;      // resets on success or lockout-clear
  readonly lockedUntil: Date | null;       // null when not locked
  readonly displayName: string | null;     // optional — set during invitation redemption
}
```

**Invariants** (domain-layer policies, checked by the Application layer before
persistence):

- `email` is globally unique (case-insensitive) per spec Q2.
- Exactly **one** `role`. Roles cannot be combined.
- `status === 'pending'` ⇒ `lastSignInAt === null`, `lastPasswordChangedAt === null`.
- `status === 'active'` with `lockedUntil > now()` ⇒ sign-in MUST be rejected.
- `failedSignInCount` MUST NOT exceed 5 without `lockedUntil` being set for 15 min.
- There MUST always be at least one `role === 'admin'` AND `status === 'active'`
  user — enforced by the `disable-user` and `change-role` use cases with a
  SELECT-FOR-UPDATE row lock on the admin count (spec FR-011).

### 2.4 `Session`

```ts
// src/modules/auth/domain/session.ts
export interface Session {
  readonly id: SessionId;        // 32-byte random, hex-encoded (64 chars)
  readonly userId: UserId;
  readonly createdAt: Date;      // absolute reference point
  readonly lastSeenAt: Date;     // sliding reference point
  readonly expiresAt: Date;      // createdAt + 12 hours (absolute cap)
  readonly sourceIp: string;     // captured at sign-in; informational only
}

export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;          // 30 min
export const ABSOLUTE_LIFETIME_MS = 12 * 60 * 60 * 1000; // 12 h

export function isSessionValid(s: Session, now: Date): boolean {
  if (s.expiresAt.getTime() <= now.getTime()) return false;           // absolute
  if (now.getTime() - s.lastSeenAt.getTime() > IDLE_TIMEOUT_MS) return false; // idle
  return true;
}
```

### 2.5 `PasswordResetToken`

```ts
// src/modules/auth/domain/token.ts
export interface PasswordResetToken {
  readonly id: TokenId;              // 32-byte random hex
  readonly userId: UserId;
  readonly createdAt: Date;
  readonly expiresAt: Date;          // createdAt + 1 hour
  readonly consumedAt: Date | null;  // set on first use
}
```

**Invariants**:
- Single-use: once `consumedAt` is set, the token is dead; a second use is
  rejected with a generic "invalid or expired link" message (no leak).
- At-most-one live token per user at a time: creating a new reset token
  invalidates (sets `consumedAt`) any existing un-consumed tokens for the
  same user.

### 2.6 `Invitation`

```ts
// src/modules/auth/domain/token.ts
export interface Invitation {
  readonly id: TokenId;              // 32-byte random hex
  readonly userId: UserId;           // the pending user being invited
  readonly invitedByUserId: UserId;  // actor (admin)
  readonly intendedRole: Role;       // mirrors the pending user's role
  readonly createdAt: Date;
  readonly expiresAt: Date;          // createdAt + 7 days
  readonly consumedAt: Date | null;
}
```

**Invariants**:
- Single-use and time-bound.
- The pending `UserAccount` row and the `Invitation` row are created
  atomically in the same transaction — you never have one without the other.
- `intendedRole` is stored on the invitation for tamper-evidence; the use case
  verifies it matches `user.role` when the token is redeemed.

### 2.7 `AuditEvent`

```ts
// src/modules/auth/domain/audit-event.ts
export const AUDIT_EVENT_TYPES = [
  'sign_in_success',
  'sign_in_failure',
  'sign_out',
  'password_reset_requested',
  'password_reset_completed',
  'password_changed',               // Q3-B addition (change while signed in)
  'account_created',
  'account_disabled',
  'account_reenabled',
  'role_changed',
  'lockout_triggered',              // Q3-B addition
  'lockout_cleared',                // Q3-B addition
  'session_forcibly_ended',
  'concurrent_sessions_revoked',    // Q3-B addition (bundled event per password change)
  'manager_denied_write',           // Q3-B addition
  'invitation_redemption_failed',   // Q3-B addition (expired or used invite)
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditEvent {
  readonly id: AuditEventId;
  readonly timestamp: Date;          // UTC, immutable
  readonly eventType: AuditEventType;
  readonly actorUserId: UserId | 'anonymous' | 'system:bootstrap';
  readonly targetUserId: UserId | null;
  readonly sourceIp: string | null;
  readonly summary: string;          // short human-readable, max 500 chars
  readonly requestId: string;        // correlation with logs/traces
}
```

**Invariants**:
- **Append-only.** No UPDATE. No DELETE (before the 5-year retention window).
  Enforced at the DB level via revoked grants — see § 7.
- `actorUserId === 'anonymous'` is permitted for `sign_in_failure` events
  where the email did not exist (do not reveal which).
- `summary` MUST NOT contain plaintext passwords, reset tokens, or session IDs.

---

## 3. Relationships

```
UserAccount (1) ──< (N) Session                   (on cascade: delete sessions on user delete; sign-out on user disable)
UserAccount (1) ──< (N) PasswordResetToken        (single live token enforced in app layer)
UserAccount (1) ──< (N) Invitation                (one live invitation per pending user)
UserAccount (1) ──< (N) AuditEvent (actor)        (no cascade; audit outlives user)
UserAccount (1) ──< (N) AuditEvent (target)       (no cascade)
```

**Cascade policy**:
- `Session → UserAccount`: `ON DELETE CASCADE` — sessions are worthless without a user.
- `PasswordResetToken → UserAccount`: `ON DELETE CASCADE` — tokens are worthless without a user.
- `Invitation → UserAccount`: `ON DELETE CASCADE` on the pending user;
  `ON DELETE RESTRICT` on the inviting admin (cannot delete an admin while
  their unredeemed invitations exist).
- `AuditEvent → UserAccount`: **NO CASCADE** on either actor or target.
  Audit events outlive the users they reference. Deleting a user (very rare;
  normally disable) preserves audit events with a dangling user-id reference
  that the reader resolves to "deleted user".

---

## 4. State machines (summary)

### 4.1 `UserAccount.status`

```
(admin invite) ─────▶ pending
                       │
                       │ (redeem invite, set password)
                       ▼
                     active ◀──────┐
                       │           │
                       │ (disable) │ (re-enable)
                       ▼           │
                     disabled ─────┘
```

### 4.2 Session lifecycle

```
(sign-in) ─▶ active (last_seen_at updated on each request)
                │
                ├── (sign-out)                    ─▶ deleted
                ├── (password change)             ─▶ deleted (all other sessions for same user)
                ├── (role change)                 ─▶ deleted (all sessions for affected user)
                ├── (account disabled)            ─▶ deleted (all sessions for that user)
                ├── (idle > 30 min)               ─▶ deleted (next access)
                └── (absolute expiry > 12 h)      ─▶ deleted (next access)
```

### 4.3 Token lifecycle (shared by `PasswordResetToken` and `Invitation`)

```
(create) ─▶ live (consumed_at IS NULL, expires_at > now)
              │
              ├── (use successfully) ─▶ consumed (consumed_at set)
              └── (expire)           ─▶ expired (expires_at <= now, still un-consumed) → rejected on use
```

---

## 5. Validation rules (cross-entity)

From spec FRs and SCs, mapped to the data model:

| Rule | Enforced where | Source |
|---|---|---|
| Email is system-unique (case-insensitive) | DB `UNIQUE` constraint on `lower(email)` | spec Q2, FR-001 |
| Exactly one role per account | DB `NOT NULL` + CHECK on `role IN (...)` | spec Q2, FR-002 |
| Password verifier never plaintext | Application layer hashes via argon2id BEFORE insert | FR-007 |
| At least one active admin always exists | `disable-user` + `change-role` use cases run a `SELECT count(*) FROM users WHERE role = 'admin' AND status = 'active' FOR UPDATE` inside the same transaction as the mutation | FR-011 |
| Session idle ≤ 30 min | Domain `isSessionValid` + middleware | FR-008, Q3 |
| Session absolute ≤ 12 h | Domain `isSessionValid` + `expires_at` | FR-008, Q3 |
| Reset token TTL ≤ 1 h | Domain + DB `CHECK (expires_at = created_at + interval '1 hour')` | FR-005, Q3 |
| Invitation TTL ≤ 7 days | Domain + DB CHECK | FR-009, Q3 |
| Lockout after 5 failures / 15 min | Application layer (`sign-in` use case) + rate limiter | FR-013, Q3 |
| Audit log append-only, ≥ 5-year retention | DB grants (no UPDATE, no DELETE for app role) + partitioning by year | FR-012, Constitution VIII |

---

## 6. Volume estimates

Based on spec § Assumptions (scale):

| Table | 5-year row estimate | Retention | Index strategy |
|---|---|---|---|
| `users` | ~600 | indefinite | unique on `lower(email)`; btree on `role, status` for admin-count checks |
| `sessions` | ~1 000 (peak ~50 concurrent) | 12 h max | btree on `id` (PK), `user_id`, `expires_at` (for reaper job) |
| `password_reset_tokens` | ~50 per month | 1 h max | btree on `id` (PK), `user_id` |
| `invitations` | ~50 per year | 7 days max | btree on `id` (PK), `user_id` |
| `audit_log` | ~50 k per year (10 events per user per year × 500 users × 10 because of failed sign-ins) | 5 years (250 k rows total) | btree on `timestamp DESC`, `actor_user_id`, `target_user_id`, `event_type` (for filters) |

All well within Neon's free-tier capacity (10 GB storage) for years. No
sharding. No partitioning for F1 (re-evaluate when `audit_log` approaches
1 M rows).

---

## 7. SQL schema (`src/modules/auth/infrastructure/db/schema.ts` — Drizzle)

```ts
// src/modules/auth/infrastructure/db/schema.ts
import { sql } from 'drizzle-orm';
import {
  pgTable, text, timestamp, integer, uuid, inet, index, uniqueIndex, pgEnum,
} from 'drizzle-orm/pg-core';

// Enums
export const roleEnum = pgEnum('role', ['admin', 'manager', 'member']);
export const userStatusEnum = pgEnum('user_status', ['pending', 'active', 'disabled']);
export const auditEventTypeEnum = pgEnum('audit_event_type', [
  'sign_in_success',
  'sign_in_failure',
  'sign_out',
  'password_reset_requested',
  'password_reset_completed',
  'password_changed',
  'account_created',
  'account_disabled',
  'account_reenabled',
  'role_changed',
  'lockout_triggered',
  'lockout_cleared',
  'session_forcibly_ended',
  'concurrent_sessions_revoked',
  'manager_denied_write',
  'invitation_redemption_failed',
]);

// users
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    role: roleEnum('role').notNull(),
    status: userStatusEnum('status').notNull().default('pending'),
    passwordHash: text('password_hash'),                 // NULL while status = 'pending'
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
    lastPasswordChangedAt: timestamp('last_password_changed_at', { withTimezone: true }),
    failedSignInCount: integer('failed_signin_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (table) => ({
    emailUniqueIdx: uniqueIndex('users_email_lower_unique').on(sql`lower(${table.email})`),
    roleStatusIdx: index('users_role_status_idx').on(table.role, table.status),
  }),
);

// sessions
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),                          // 64-hex session ID
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    sourceIp: inet('source_ip').notNull(),
  },
  (table) => ({
    userIdIdx: index('sessions_user_id_idx').on(table.userId),
    expiresAtIdx: index('sessions_expires_at_idx').on(table.expiresAt),
  }),
);

// password_reset_tokens
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => ({
    userIdIdx: index('password_reset_tokens_user_id_idx').on(table.userId),
  }),
);

// invitations
export const invitations = pgTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    intendedRole: roleEnum('intended_role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => ({
    userIdIdx: index('invitations_user_id_idx').on(table.userId),
  }),
);

// audit_log — append-only
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    eventType: auditEventTypeEnum('event_type').notNull(),
    actorUserId: text('actor_user_id').notNull(),         // UUID or 'anonymous' or 'system:bootstrap'
    targetUserId: uuid('target_user_id'),                 // NULL allowed
    sourceIp: inet('source_ip'),
    summary: text('summary').notNull(),
    requestId: text('request_id').notNull(),              // correlation ID
  },
  (table) => ({
    timestampIdx: index('audit_log_timestamp_idx').on(sql`${table.timestamp} DESC`),
    actorIdx: index('audit_log_actor_idx').on(table.actorUserId),
    targetIdx: index('audit_log_target_idx').on(table.targetUserId),
    eventTypeIdx: index('audit_log_event_type_idx').on(table.eventType),
  }),
);
```

### 7.1 Append-only enforcement for `audit_log`

A dedicated SQL migration (`drizzle/migrations/000x_audit_log_grants.sql`)
creates an application-role Postgres user with **INSERT-only** grants on
`audit_log`. UPDATE and DELETE are denied at the DB level. Reads are via
a separate, read-only role used by the (future) audit log viewer UI.

```sql
-- drizzle/migrations/000x_audit_log_grants.sql
CREATE ROLE swecham_app_rw;
CREATE ROLE swecham_app_ro;

GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, password_reset_tokens, invitations TO swecham_app_rw;
GRANT SELECT, INSERT                ON audit_log TO swecham_app_rw;  -- INSERT only, no UPDATE/DELETE
GRANT SELECT                        ON audit_log TO swecham_app_ro;

REVOKE UPDATE, DELETE ON audit_log FROM swecham_app_rw, swecham_app_ro;
```

### 7.2 Retention

A nightly cron (Phase 2 concern — not F1) will:
- Delete expired sessions (`expires_at < now()`) — housekeeping.
- Delete expired + consumed reset tokens older than 1 day.
- Delete expired + consumed invitations older than 14 days.
- Archive audit_log rows older than 5 years to cold storage (F1 leaves the
  rows in place; 250 k rows × 5 years is tiny).

F1 implements only the **application-triggered** cleanup (consume-on-use);
the nightly job is out of scope.

---

## 8. Mapping Domain ↔ Infrastructure

The Repository layer (`src/modules/auth/infrastructure/db/*-repo.ts`) is
responsible for translating Drizzle row types to/from the pure Domain types.

Example (`user-repo.ts`):

```ts
// infrastructure/db/user-repo.ts
import { users } from './schema';
import type { UserAccount } from '@/modules/auth/domain/user';

function toDomain(row: typeof users.$inferSelect): UserAccount {
  return {
    id: row.id as UserId,
    email: row.email.toLowerCase() as EmailAddress,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    lastSignInAt: row.lastSignInAt,
    lastPasswordChangedAt: row.lastPasswordChangedAt,
    failedSignInCount: row.failedSignInCount,
    lockedUntil: row.lockedUntil,
    displayName: row.displayName,
  };
}
```

The Application layer (`src/modules/auth/application/sign-in.ts` etc.)
**never imports from `drizzle-orm`** — only from Domain types and from the
repo interfaces. An ESLint `no-restricted-imports` rule enforces this:

```jsonc
// .eslintrc.cjs (excerpt)
{
  "overrides": [
    {
      "files": ["src/modules/auth/domain/**/*.ts"],
      "rules": {
        "no-restricted-imports": ["error", {
          "patterns": ["drizzle-orm", "drizzle-orm/*", "next/*", "react", "resend", "@upstash/*"]
        }]
      }
    },
    {
      "files": ["src/modules/auth/application/**/*.ts"],
      "rules": {
        "no-restricted-imports": ["error", {
          "patterns": ["drizzle-orm", "drizzle-orm/*", "next/*", "react"]
        }]
      }
    }
  ]
}
```

This is how Constitution Principle III (Clean Architecture) is **mechanically
enforced** — not by convention.
