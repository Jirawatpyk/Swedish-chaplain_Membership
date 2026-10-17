---
name: add-audit-event
description: Add a new audit_event_type value to Chamber-OS — the five code places, the enum migration, the three locale labels, and the count tests that go red when one is missed. Use whenever a change emits an audit event type that does not exist yet, in any module.
---

# Add an audit event type

Every audit event type lives in several places that must agree. Missing one has turned `main` red more than once, because the per-module pre-push gate does not run `tests/integration/audit/`.

## 1. Decide where it is declared

- **Every new value** goes into the `auditEventTypeEnum` pgEnum tuple in `src/modules/auth/infrastructure/db/schema.ts`. A value missing there shows as TS2769 "no overload" on every typed insert.
- **The module's own taxonomy**, when it has one: e.g. `F7_AUDIT_EVENT_TYPES` in `src/modules/broadcasts/application/ports/audit-port.ts` (static-asserted), or the F5 / F8 / F9 lists. The comments beside each tuple block in `schema.ts` say which list to keep in lockstep.
- **An F1 audit-taxonomy event** (auth, members' F1-level events such as F114's) also goes into `AUDIT_EVENT_TYPES` in `src/modules/auth/domain/audit-event.ts`.
- `DB_ONLY_AUDIT_EVENT_TYPES` is **legacy**: values that older migrations added without syncing the tuple. Don't add new values there.
- `ALL_AUDIT_EVENT_TYPES` (the tuple ∪ `DB_ONLY_`) must equal the live enum.

## 2. The places to change

1. `auditEventTypeEnum` in `schema.ts`.
2. The module's taxonomy list and its count test, if it has one; and `AUDIT_EVENT_TYPES` for an F1 audit-taxonomy event.
3. The count in `tests/unit/auth/domain/audit-event.test.ts` (`toHaveLength(N)`), if `AUDIT_EVENT_TYPES` grew.
4. The count in `tests/integration/audit/completeness.test.ts` (`AUDIT_EVENT_TYPES.length` and the `describe` title), if `AUDIT_EVENT_TYPES` grew.
5. The label `audit.eventType.<value>` in `src/i18n/messages/en.json`, `th.json` and `sv.json`. `tests/unit/insights/audit-event-label-coverage.test.ts` enforces it, and the F9 audit viewer shows the raw value without it.

Before running anything, grep `tests/` for the **old** count (`toHaveLength(` and `length).toBe(`) to find every assertion that must move.

## 3. The migration

Use the `new-migration` skill. The SQL is an idempotent `DO $$` block (pattern: `drizzle/migrations/0014_audit_event_portal_invite_queued.sql`):

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = '<value>'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE '<value>';
  END IF;
END$$;
```

## 4. The payload

- Member-related events carry snake_case `member_id`. The `last_activity_at` trigger reads only that key, and `memberId` silently does nothing.
- `actor_role` records the role the actor actually held, or `null` — never a fallback such as `?? 'admin'` (`pnpm check:actor-role-truth`).
- Decide the retention: `audit_log.retention_years` defaults to 5. Tax-document events use 10.
- When parsing enum values out of SQL or TS, capture `'([^']+)'`: three existing values contain a hyphen.

## 5. Prove it

- `pnpm vitest run tests/unit/auth/domain/audit-event.test.ts tests/unit/insights/audit-event-label-coverage.test.ts`
- `pnpm test:integration tests/integration/audit/completeness.test.ts`
- `pnpm check:i18n`, plus `pnpm check:audit-events` / `pnpm check:audit-counts` when the module keeps its own count.
