# Runbook — Payment Cross-Tenant Probe (F5)

**Severity:** **alarm** → `#oncall-payments` + on-call email digest
(`docs/observability.md` § 21.7). Escalates to a security incident if the actor is
confirmed hostile.
**Trigger:** `payment_cross_tenant_probe` ≥ 1 within 5 min (`docs/observability.md` § 21.3).
**Surface:** F5 payments — `initiate-payment`, `cancel-payment`, and the F4 invoicing bridge.
**Owner:** Payments maintainers + whoever holds the security-reviewer role for the release.

> **Why this runbook exists.** It backs the **only Constitution Principle I (tenant
> isolation) alert in F5**. `docs/observability.md` § 21.3 has pointed at this file since
> the F5 catalogue was written; the file itself was never created and the reference
> dangled until 2026-07-19. If you are reading this during an incident, the procedure
> below was reconstructed from the emit sites — **verify the payload shape against
> `src/modules/payments/application/ports/audit-port.ts` before relying on field names.**

**Related code**
- Emit sites: `src/modules/payments/application/use-cases/initiate-payment.ts`,
  `src/modules/payments/application/use-cases/cancel-payment.ts`
- Payload contract: `audit-port.ts` → `payment_cross_tenant_probe`
- Enum member: `src/modules/auth/infrastructure/db/schema.ts`
- Retention: **5 years** (`retentionFor('payment_cross_tenant_probe')`)

**Siblings** — same class, different bounded context, both documented **inline** in
`docs/observability.md` rather than as files:
- F2 plans → § 12.1 (`plan_cross_tenant_probe`)
- F4 invoicing → § 19.1 (`invoice_cross_tenant_probe` / `credit_note_cross_tenant_probe`)

---

## What it means

A request authenticated for tenant **A** referenced a payment-surface entity owned by
tenant **B**. The application layer refused it and the caller received a **404 / 403** —
the probe did **not** read cross-tenant data. Two independent layers must both hold for
that to be true (Constitution Principle I two-layer isolation): the application-layer
tenant check that produced this audit row, **and** the Postgres RLS + FORCE policies
beneath it.

**The alert is therefore about intent, not breach.** One row is usually a mistyped id or
a stale bookmark. A burst from one actor across many target ids is enumeration.

**When to treat it as a breach instead:** if the probe row is accompanied by a *successful*
read of the same target id, the application check fired but something returned data anyway
— that is an RLS failure, not a probe. Go straight to
`docs/runbooks/rls-row-security-incident.md` and `docs/runbooks/breach-notification.md`.

## Step 1 — Pull the probe rows

```sql
SELECT
  timestamp,
  actor_user_id,
  source_ip,
  request_id,
  tenant_id                          AS acting_tenant,
  payload->>'target_entity'          AS target_entity,
  payload->>'target_id'              AS target_id,
  payload->>'subject_tenant_id'      AS owning_tenant,
  payload->>'bridge_outcome'         AS bridge_outcome,
  summary
FROM audit_log
WHERE event_type = 'payment_cross_tenant_probe'
  AND timestamp >= NOW() - INTERVAL '24 hours'
ORDER BY timestamp DESC
LIMIT 50;
```

> `audit_log`'s time column is **`timestamp`**, not `created_at`.
> `subject_tenant_id` and `bridge_outcome` are optional in the payload contract — not
> every emit site sets them. `target_entity` is typically `invoice` or `payment`.

## Step 2 — Classify the shape

```sql
-- Enumeration test: one actor, many distinct targets, short window.
SELECT
  actor_user_id,
  COUNT(*)                                    AS probes,
  COUNT(DISTINCT payload->>'target_id')       AS distinct_targets,
  MIN(timestamp)                              AS first_seen,
  MAX(timestamp)                              AS last_seen
FROM audit_log
WHERE event_type = 'payment_cross_tenant_probe'
  AND timestamp >= NOW() - INTERVAL '24 hours'
GROUP BY actor_user_id
ORDER BY distinct_targets DESC;
```

| Shape | Reading | Go to |
|---|---|---|
| 1–2 probes, 1 target id, one actor | Mistyped id, stale bookmark, or a link shared between tenants | Step 3 — benign |
| Many distinct targets, one actor, minutes apart | **Enumeration** | Step 4 — hostile |
| Many actors, same target id | Likely a shared broken link, not an attack — find and fix the link | Step 3 — benign |
| Probes from a `system:*` or service actor | A code path is passing the wrong tenant context. **This is a bug, not an attacker** | Step 5 — code defect |

## Step 3 — Benign path

1. Confirm the actor is a known, active session belonging to the acting tenant.
2. Contact the user; confirm what they were trying to reach.
3. If it was a shared or stale link, get it corrected at the source.
4. Close the alert with a one-line note naming the actor and target. **Do not** delete or
   amend the audit rows — `audit_log` is append-only and these carry 5-year retention.

## Step 4 — Hostile path

1. **Revoke the actor's sessions** for that user id.
2. Preserve evidence: record the `request_id`s and `source_ip`s from Step 1. They are your
   correlation keys into pino logs (**30-day retention — pull anything you need now**,
   the audit rows persist but the logs will not).
3. Notify the acting tenant's admin **and** the owning tenant's admin.
4. **Confirm nothing was actually read.** Verify no successful payment/invoice read exists
   for those `target_id`s under the acting tenant, and check the RLS incident runbook if
   anything looks ambiguous.
5. If cross-tenant PII was exfiltrated, this becomes a breach:
   `docs/runbooks/breach-notification.md` (PDPA §37 / GDPR Art. 33 clocks start at
   awareness — do not sit on it).
6. File the incident under `specs/009-online-payment/reviews/incident-NNN.md`, matching
   the F4 convention in `docs/observability.md` § 19.1 step 5.

## Step 5 — Code-defect path

A probe attributed to a system/service actor means an internal call is threading the wrong
`TenantContext` — most often a repo method reaching for the pool-global `db` singleton
instead of the `tx` from `runInTenant` (see CLAUDE.md § Gotchas; this bypasses
`SET LOCAL app.current_tenant` and RLS will not save you).

1. Use `request_id` to find the call path in the logs.
2. Check whether the same request also *succeeded* at anything cross-tenant. If it did,
   treat as an isolation breach immediately — `rls-row-security-incident.md`.
3. Fix forward with a regression test. The cross-tenant integration test is a Review-Gate
   blocker under Principle I, so the fix ships with one by definition.

## Prevention / monitoring

- Alert rule and severity: `docs/observability.md` § 21.3 (`payment_cross_tenant_probe`
  ≥ 1 / 5 min → **alarm**). The `≥ 1` threshold is tunable-free by design — a probe count
  has no healthy baseline to calibrate against.
- The F5 metric counterpart of the F4 `invoicing_cross_tenant_probe_total` counter
  **does not exist**; F5 probes are observable **only** as `audit_log` rows. Any dashboard
  panel or alert must query the audit table, not a metric time series.
- § 21.7 routes **info**-level low-frequency probes to audit-log-only, escalating to
  **alarm** at ≥ 1 / 5 min.

## Related runbooks

- `docs/runbooks/rls-row-security-incident.md` — when isolation may have actually failed
- `docs/runbooks/breach-notification.md` — PDPA §37 / GDPR Art. 33 notification
- `docs/runbooks/credential-compromise.md` — if the probing session was hijacked
- `docs/observability.md` § 12.1 (F2) and § 19.1 (F4) — sibling procedures
