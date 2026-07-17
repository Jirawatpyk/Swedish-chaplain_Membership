# Runbook — RLS `row_security = off` connection contamination

**Severity**: HIGH (intermittent 5xx on any tenant-scoped page/action)
**Owner**: Platform on-call
**First seen**: 2026-07-05 (isolated); **incident**: 2026-07-17

## Symptom

Intermittent server errors on tenant surfaces, digest shown to the user as
"Error ID: <digest>". Vercel runtime logs show:

```
Failed query: SELECT ... FROM <tenant_table> WHERE tenant_id = $1
cause: query would be affected by row-level security policy for table "<tenant_table>"
code: '42501'  file: 'rls.c'  routine: 'check_enable_rls'
```

Affected tables are always **tenant-scoped, FORCE-RLS** ones
(`tenant_member_settings`, `tenant_invoice_settings`,
`tenant_renewal_schedule_policies`, `membership_plans`, `members`, …). The
failure is **intermittent** — the same page works on a retry.

## Root cause

SQLSTATE `42501` "query would be affected by row-level security policy" is
raised when a session has **`row_security = off`** and a role that is
**subject to RLS** reads a **FORCE ROW LEVEL SECURITY** table (Postgres
refuses to silently ignore the RLS request).

The app connects as the Neon owner role (BYPASSRLS) and `runInTenant`
(`src/lib/db.ts`) drops to the NOBYPASSRLS `chamber_app` role per
transaction via `SET LOCAL ROLE chamber_app`. If the pooled connection has
inherited a stale **session-level** `SET row_security = off`, then inside
`runInTenant` the read runs as `chamber_app` (RLS-subject) with
row_security off → **42501**.

**How the connection gets contaminated**: the Neon pooler is pgbouncer in
**transaction mode**. A session-level `SET row_security = off` executed
*outside* a transaction (e.g. by an ops/inspection script connecting as the
owner) is not reset at a transaction boundary and lingers on the pooled
server connection, poisoning subsequent app transactions on that connection
until it is recycled. The 2026-07-17 incident was triggered this way by a
one-off user-inspection script.

## Fix (code — shipped)

`runInTenant` now issues **`SET LOCAL row_security = on`** as the first
statement of every tenant transaction (before `SET LOCAL ROLE chamber_app`).
`SET LOCAL` is transaction-scoped, so even a contaminated connection is
forced back to `row_security = on` for the duration of the tenant work — RLS
is always enforced, never errored or bypassed. Regression guard:
`tests/integration/rls-row-security-hardening.test.ts` (reproduces the 42501
on a poisoned connection and proves the fix defends).

## Immediate remediation (if it recurs before/without the code fix)

The contamination lives on pooled **server-side** Neon connections, so an app
redeploy alone does NOT clear it (it only resets the app's client pool).

1. **Restart the Neon compute endpoint** (Neon console → project → Branches
   → compute → Restart; or suspend + resume). This drops all server
   connections; fresh ones start at the `row_security = on` default. Fastest
   deterministic fix.
2. Or wait — poisoned pooled connections are recycled on idle timeout
   (minutes to ~1h), after which the errors stop on their own.

## Prevention

- **NEVER run a session-level `SET row_security = off` (or any session-level
  `SET`) against the shared pooled endpoint** (`...-pooler...`). It leaks
  across clients in transaction mode. For owner-level ad-hoc reads that must
  bypass RLS, the owner already has BYPASSRLS — `SET row_security = off` is
  redundant *and* dangerous. If you must, use the **direct (non-pooled)**
  endpoint on a throwaway connection you close immediately.
- The `runInTenant` `SET LOCAL row_security = on` above makes the app immune
  regardless of connection contamination — the durable defence.
