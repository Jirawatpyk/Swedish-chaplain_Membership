# Auth & RBAC Runbook (F1)

**Scope**: operational procedures for the SweCham / TSCC auth subsystem shipped by feature F1 (`001-auth-rbac`). Owners: SweCham platform team. On-call reference during incidents.

**Paging contact**: the sign-in failure-rate SLO (docs/observability.md § 6) pages on-call when the 15-minute rolling failure rate exceeds 10%. This runbook is what you reach for when the pager goes off.

---

## 0. At-a-glance

| Lever | Where | Reversible? |
|---|---|---|
| Bootstrap first admin | `pnpm tsx scripts/seed-bootstrap-admin.ts` | Yes — refuses if any admin exists |
| Emergency write freeze | Set `READ_ONLY_MODE=true` in Vercel env + redeploy | ~30 s, no code change |
| Release / lockout | `DELETE FROM users WHERE id = :id THEN UPDATE SET locked_until = NULL, failed_attempts = 0` | Yes |
| Rotate all sessions (user) | `DELETE FROM sessions WHERE user_id = :id` | Yes, forces re-sign-in |
| Rotate all sessions (global) | `DELETE FROM sessions` | **Disruptive** — every user must re-sign-in |
| Rollback deployment | `vercel promote <previous-deployment-url>` | Yes |

---

## 1. Bootstrap the first admin (fresh environment)

The app has no admin by default. Running the seed script is **safe to re-run** — it refuses if any admin already exists.

```bash
BOOTSTRAP_ADMIN_EMAIL=first.admin@swecham.example \
BOOTSTRAP_ADMIN_DISPLAY_NAME='First Admin' \
pnpm tsx scripts/seed-bootstrap-admin.ts
```

The script prints a one-time activation URL; deliver it to the admin out-of-band. That URL hits `/invite/[token]` and the admin sets their password. **No admin password is ever typed at the terminal.**

If the script refuses with "an active admin already exists", either (a) sign in as that admin and use `/admin/users` to create another, or (b) use **§ 2** to disable the existing admin first.

---

## 2. Common incidents

### 2.1 Lockout spike — sign-in failure rate jumps above 10%

**Signal**: `auth_signin_attempts_total{result="invalid_credentials"}` climbs (Vercel Analytics dashboard, docs/observability.md § 7.1).

**Likely causes**:
1. **Credential stuffing** — one IP attempting many email addresses.
2. **Password manager misconfiguration** — real users repeatedly failing after a policy tightening.
3. **Upstream identity provider outage** (not us — we have no upstream).

**Triage steps**:

1. **Check Upstash sliding-window keys** for a hot IP:
   ```bash
   vercel env pull .env.local
   pnpm tsx scripts/clear-rate-limit.ts --dry-run --pattern 'swecham:signin:ip:*'
   ```
   If one IP dominates, that's a brute-force burst. The per-IP limiter (30 / 15 min) is already throttling it, but you can confirm the defence is working by checking that `auth_signin_attempts_total{result="rate_limited"}` is ≳ 95% of the burst.

2. **Audit log query** — find affected users:
   ```sql
   SELECT actor_user_id, COUNT(*) as failures
   FROM audit_log
   WHERE event_type = 'sign_in_failure'
     AND created_at > NOW() - INTERVAL '15 minutes'
   GROUP BY actor_user_id
   ORDER BY failures DESC
   LIMIT 20;
   ```

3. **If you confirm brute-force** and the per-IP limiter is holding: **no action needed**, the system is defending itself as designed. Let it ride and update the incident with "contained by rate limiter".

4. **If you see real users locked out en masse** (e.g., after a policy change): consider clearing specific users' `locked_until` + `failed_attempts` in the DB:
   ```sql
   UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE email IN (:list);
   ```
   Do NOT do this globally — it weakens the account-lockout defence.

### 2.2 Email delivery failure spike

**Signal**: `auth_email_send_failures_total` climbs; Resend webhook returns `email.bounced` or `email.delivery_delayed` at high rates.

**Triage steps**:

1. **Check Resend status page** (https://status.resend.com) first. If they're having an incident, we wait.

2. **Query email_delivery_events** for the most recent failures:
   ```sql
   SELECT event_type, COUNT(*), MIN(occurred_at), MAX(occurred_at)
   FROM email_delivery_events
   WHERE occurred_at > NOW() - INTERVAL '1 hour'
   GROUP BY event_type;
   ```
   If `delivered` is zero and `bounced` is the majority → likely DNS/SPF/DKIM issue, not a Resend outage.

3. **Verify DNS**:
   ```bash
   dig txt swecham.example
   dig dkim1._domainkey.swecham.example
   ```
   Compare against the values in the Resend dashboard's Domain Verification page.

4. **If email is degraded but sign-in works**: set `READ_ONLY_MODE=false` (the default) and let sign-in continue. Password resets and invitations will queue as "requested" in the audit log; you can replay them when email recovers.

### 2.3 Admin lockout — no one can sign in as admin

**Scenario**: the only admin is locked out (failed password attempts, or accidental self-disable). The spec has a last-admin protection (T125 `disable-user`) that refuses to disable the last active admin, so this should only happen via the lockout path, not self-disable.

**Recovery**:

```sql
-- Verify there is still exactly one admin
SELECT id, email, status, locked_until, failed_attempts
FROM users
WHERE role = 'admin' AND status = 'active';

-- Clear the lockout for that admin
UPDATE users
SET locked_until = NULL, failed_attempts = 0
WHERE id = :admin_id;
```

If ALL admins are `disabled` (which means the last-admin guard failed — file a bug): temporarily re-enable one:

```sql
UPDATE users SET status = 'active' WHERE id = :admin_id;
```

Then immediately create a second admin via the UI (`/admin/users` → invite) so the last-admin condition never recurs.

### 2.4 Suspicious audit trail gap

**Signal**: audit consumers report a gap; or `auth_audit_missing_total` > 0.

The audit_log has an append-only trigger (`drizzle/migrations/0001_audit_log_append_only.sql`) that RAISES EXCEPTION on any DELETE or UPDATE. So a gap can only come from:
- A code path that failed to emit (application bug) — fix in code.
- A Neon PITR restore that rolled back audit rows (see Neon support).

**Do NOT** try to backfill missing events by inserting rows — that breaks the chain-of-custody narrative. Instead, document the gap in an incident report and lean on pino logs + Vercel runtime logs as the secondary source of truth.

### 2.5 Redis (Upstash) outage

**Signal**: `auth_redis_fallback_total` > 0; rate-limit decisions start hitting the in-memory fallback.

**Behaviour during outage**: the limiter falls back to a process-local in-memory map (`src/modules/auth/infrastructure/rate-limit/upstash-rate-limiter.ts`). This means a determined attacker can spread load across multiple serverless functions to bypass the per-IP limit, but the per-user lockout (`users.failed_attempts`) still protects individual accounts.

**Action**:
1. Confirm Upstash is down (status page + a manual `PING`).
2. If the outage is bounded (< 15 min): no action; the fallback is adequate.
3. If prolonged: consider setting `READ_ONLY_MODE=true` to stop all mutations and sign-ups until the limiter is back.
4. Capture the incident in the runbook log with the start/end timestamps.

---

## 3. Emergency write freeze (`READ_ONLY_MODE`)

When an incident requires us to stop all state mutations without taking the site down, set `READ_ONLY_MODE=true` in Vercel env vars and redeploy. The proxy (`src/proxy.ts`) returns `503 {"error":"read-only-mode"}` on every state-changing `/api/**` route while keeping sign-in and reads alive.

**Reversible in ~30 seconds without a code deploy** — flip the env var back to `false` and redeploy.

Use cases:
- Discovered a critical data-integrity bug; need to stop writes while we ship a fix.
- PII leak confirmed — halt new writes so we don't compound the exposure.
- Payment provider (F5) is misrouting funds — pause invoice marking-as-paid.

---

## 4. Rollback procedure

### 4.1 Application rollback

Vercel stores every deployment; rolling back is:

```bash
# Find the previous known-good deployment URL
vercel ls

# Promote it to production
vercel promote <deployment-url>
```

This is instant and does NOT re-run migrations. If the broken deployment ran a DB migration you need to reverse, see § 4.2.

### 4.2 Database rollback

**Forward-only migrations are the norm.** Rolling back a migration means writing a new "un-do" migration, not reverting the SQL file. Steps:

1. Identify the broken migration in `drizzle/migrations/`.
2. Write a new migration that reverses it (drop column, restore constraint, etc.).
3. Ship it through the normal PR flow (or, for genuine emergencies, via `pnpm drizzle-kit migrate` against production — but this requires two humans and an incident record).

**Audit log is protected** — the append-only trigger refuses DELETE / UPDATE even from the migration layer. If you need to roll back an audit-log schema change, you must first DROP the trigger, then apply the un-do, then re-create the trigger.

### 4.3 Session mass-invalidation

If we suspect a session compromise (stolen cookie, intercepted token):

```sql
-- Kill every session for one user
DELETE FROM sessions WHERE user_id = :user_id;

-- Kill every session globally — last resort, disrupts every logged-in user
DELETE FROM sessions;
```

No other side-effects — users will simply get redirected to sign-in on their next protected request.

---

## 5. Useful queries

### Count active sessions
```sql
SELECT COUNT(*) FROM sessions
WHERE last_seen_at > NOW() - INTERVAL '30 minutes'
  AND expires_at > NOW();
```

### Recent audit events for one user
```sql
SELECT created_at, event_type, summary, source_ip
FROM audit_log
WHERE actor_user_id = :user_id
ORDER BY created_at DESC
LIMIT 50;
```

### Manager write denials in the last 24 h (governance signal)
```sql
SELECT actor_user_id, COUNT(*) as denials
FROM audit_log
WHERE event_type = 'manager_denied_write'
  AND created_at > NOW() - INTERVAL '1 day'
GROUP BY actor_user_id
ORDER BY denials DESC;
```

### Pending invitations (haven't been redeemed)
```sql
SELECT id, invited_email, intended_role, expires_at
FROM invitations
WHERE consumed_at IS NULL
  AND expires_at > NOW()
ORDER BY expires_at ASC;
```

### Users locked out right now
```sql
SELECT id, email, role, locked_until, failed_attempts
FROM users
WHERE locked_until > NOW();
```

---

## 6. Cron jobs (Vercel Cron)

| Cron | Path | Schedule | Purpose |
|---|---|---|---|
| Lockout cleanup | `POST /api/cron/lockout-cleanup` | Every 5 min | Clears expired `users.locked_until` so users regain access without the lockout TTL fooling the UI |

Authentication: `Authorization: Bearer ${CRON_SECRET}`. If the secret rotates, update it in Vercel env AND in the Vercel Cron dashboard.

---

## 7. Contact

- Feature owner: F1 spec at `specs/001-auth-rbac/` — spec, plan, research, data-model, contracts, security, tasks
- On-call: SweCham platform rotation (see `docs/observability.md § 6`)
- Security contact: `security@swecham.example` (monitored by the security reviewer who signed the § 5 checklist at ship time)
