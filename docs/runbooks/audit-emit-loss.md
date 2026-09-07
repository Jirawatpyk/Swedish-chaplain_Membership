# Runbook — `audit_emit_loss`

**Owner**: Platform on-call
**Severity**: critical (Constitution Principle VIII compliance trail loss)
**Source signal**: F8-A2 alert — `renewals_coordinator_audit_emit_failed_total{cron_kind} ≥ 1` in 5-min window. Companion alerts: `broadcasts.audit.emit_failed_total ≥ 1` (F7), `invoicing.audit.emit_failed_total ≥ 1` (F4), `payments.audit.emit_failed_total ≥ 1` (F5).
**Audit events**: cascading silent failures — the very signal we're losing
**Last reviewed**: 2026-05-09 (F8 Phase 9 / T233)

---

## Why this is stop-the-line

Constitution Principle VIII (NON-NEGOTIABLE) requires every state mutation to land an audit row in the same transaction as the state change. F8 cron coordinators emit `cron_dispatch_orchestrated` audit AFTER the per-tenant fan-out to capture the orchestration outcome — a single-trip emit failure means we lose the operational record of an entire cron pass across every tenant.

If the emit failure happens **inside** a per-cycle dispatch tx, the cycle state change is rolled back automatically (atomicity). If it happens at the coordinator level (after fan-out), the per-cycle changes have already committed and the only loss is the orchestration audit — but on-call cannot tell which cycles ran, what was sent, what was skipped, and the entire cron-job.org operational dashboard is degraded.

Sustained loss = PDPA Section 39 + GDPR Article 30 records-of-processing violation.

---

## Symptom

Vercel alert fires for one of:

- `renewals_coordinator_audit_emit_failed_total{cron_kind=dispatch} ≥ 1`
- `renewals_coordinator_audit_emit_failed_total{cron_kind=at_risk_recompute} ≥ 1`
- `renewals_coordinator_audit_emit_failed_total{cron_kind=lapse} ≥ 1`
- `renewals_coordinator_audit_emit_failed_total{cron_kind=reconcile} ≥ 1`

Or the equivalent F4/F5/F7 metrics. Pino structured log line accompanies:

```
{"level":"error","msg":"cron_dispatch_orchestrated audit emit failed","cron_kind":"dispatch","correlationId":"..."}
```

---

## Triage steps (in order)

1. **Stop the line**. Pin `FEATURE_F8_RENEWALS=false` (or the affected feature flag) in Vercel env + redeploy. F8 cron coordinators short-circuit per Phase 9 / T241 within ≤30s.

2. **Identify the root cause**. The audit emit goes through `drizzle-renewal-audit-emitter.ts`; failure modes are limited:
   - **DB connection saturation**: Neon Console → connection_count vs `DATABASE_POOL_MAX`. If saturated → temporarily raise pool max + redeploy.
   - **Audit log RLS misconfiguration**: query `pg_policies` for `audit_log` — should have RLS enabled but FORCE OFF (audit table is intentionally cross-tenant readable for forensic review).
   - **`audit_event_type` enum missing the value**: `psql -c "select unnest(enum_range(null::audit_event_type))"` — confirm every F8 event type is shipped via migrations 0086+. The drizzle adapter silently no-ops on unknown event types per `F8_ENUM_SHIPPED` set; if a value is added to `F8_AUDIT_EVENT_TYPES` const without a migration to extend the pgEnum, every emit silently fails.
   - **`tenant_id` missing on the audit row**: F8 coordinator audit emits via the bookkeeping tenant slug (`env.tenant.slug`). If this env is empty or wrong, the audit insert violates the NOT NULL constraint.

3. **Replay missed audits**. OTel traces capture span attributes for every coordinator pass; the `renewals.tenants_enqueued` + `renewals.tenants_succeeded` + `renewals.tenants_failed` attributes are present. Reconstruct the missed `cron_dispatch_orchestrated` audit row manually:
   ```sql
   INSERT INTO audit_log (
     tenant_id, event_type, actor_user_id, actor_role,
     correlation_id, request_id, summary, payload, created_at
   ) VALUES (
     '<tenant>', 'cron_dispatch_orchestrated', NULL, 'system',
     '<correlation_id from trace>', NULL,
     '<reconstructed summary>', '<reconstructed payload>',
     '<trace start time>'
   );
   ```

4. **Verify the fix**. Once root cause addressed:
   - Flip `FEATURE_F8_RENEWALS=true` back.
   - Trigger a manual cron pass via cron-job.org "Run now" button.
   - Confirm `cron_dispatch_orchestrated` audit row landed.
   - Confirm `renewals_coordinator_audit_emit_failed_total` returns to 0.

5. **Postmortem** within 5 business days. Audit emit failure is rare; root cause typically points to a missing migration or pool saturation under load — both worth documenting.

---

## Escalation

- DB issue persists ≥ 30 min → engage Neon support.
- Audit-row reconstruction inconsistent with OTel trace → escalate to Security (potential evidence-tampering signal).
- Stop-the-line lasted ≥ 60 min → file as a stakeholder-visible incident.

---

## Related

- [`docs/observability.md` § 23.3](../observability.md) — F8 alert catalogue
- [`docs/runbooks/cron-jobs.md`](./cron-jobs.md) — F8 cron coordinator topology
- [`.specify/memory/constitution.md` § Principle VIII](../../.specify/memory/constitution.md) — audit-trail invariant

---

## F2 cancel-scheduled-plan-change error taxonomy (R6-S2 note)

Pin SRE alert rules to **errorId** (structured log field), NOT to message-text strings. The route-side message text at
`src/app/api/admin/scheduled-plan-changes/[id]/cancel/route.ts` was rewritten in R5 to collapse the prior double-log
(`logger.warn` + `logger.error`) into a single `logger.error`. If a prior alert rule keyed on the OLD message strings
(`'cancel-scheduled-plan-change: unhandled error'` or `'cancel-scheduled-plan-change: TOCTOU recheck failed; surfacing
original transitionStatus error'`), it stops firing silently.

The errorId taxonomy is the stable contract:

| errorId | When it fires |
|---|---|
| `F2.PLAN_CHANGE.CANCEL_SERVER_ERROR` | use-case returned `{code:'server_error', recheckFailed:false}` — primary transition error, recheck did NOT also fail |
| `F2.PLAN_CHANGE.CANCEL_RECHECK_FAILED` | use-case returned `{code:'server_error', recheckFailed:true}` — TOCTOU recheck threw on top of primary transition error |
| `F2.PLAN_CHANGE.CANCEL_AUDIT_PERSIST_FAILED` | audit DB write failed; route returns 200 + `X-Audit-Backfill-Required: 1` header |
| `F2.PLAN_CHANGE.CANCEL_AUDIT_INVALID_PAYLOAD` | audit zod schema rejected the payload (deploy-skew); route returns 200 + `X-Audit-Backfill-Required: 1` header |

For F8 `accept-tier-upgrade`:

| errorId | When it fires |
|---|---|
| `F8.ACCEPT_TIER.SERVER_ERROR` | use-case returned `{kind:'server_error', message:'deploy-skew:unhandled-gateway-arm:*'}` — gateway-arm exhaustiveness violation |
| `F8.ACCEPT_TIER.UNEXPECTED` | route's outer `catch (e)` caught an uncaught throw (R3-C3 pre-tx wrap blocks documented paths; this is defence-in-depth) |
| `F8.ACCEPT_TIER.CONTEXT_RESOLUTION_FAILED` | `requireRenewalAdminContext` caught an infrastructure error (DB outage during session-lookup). **Every F8 route emits its own `<entry>.CONTEXT_RESOLUTION_FAILED`** — see § The F8 errorId taxonomy; before 2026-09-07 all 24 emitted this one |

### The F8 errorId taxonomy

Every **admin + portal renewal route** names itself. The names live in one
place — the `F8ErrorId` union in `src/lib/renewals-route-helpers.ts` — and that
union IS the taxonomy; read it there rather than trusting a list in this file,
which is how the previous version of this section went stale.

**Read the scope sentence above literally.** It says *admin + portal renewal*,
not *F8*. An earlier draft of this section said "`F8.*` is blind to nothing",
which was false in a way that would have cost someone a night: see § Where the
taxonomy does NOT reach, below.

A route declares its entry once (`const ERROR_ID = 'F8.…'`) and uses it twice:

| suffix | emitted by | means |
|---|---|---|
| `.CONTEXT_RESOLUTION_FAILED` | `requireRenewalAdminContext`, before the route's `try` | session-lookup / RBAC infrastructure failed (DB outage) |
| `.UNEXPECTED` | the route's own outer catch | the handler threw |
| `.SERVER_ERROR`, `.ASSIGNEE_LOOKUP_FAILED`, `.KILL_SWITCH_AUDIT_EMIT_FAILED` | a named inner catch | see the route |

So a rule keyed on `<entry>.*` matches every failure **that route** can produce.
`pnpm check:f8-error-id` (pre-push + `quality-gates.yml`) enforces it: it fails
on a route in scope that declares no entry, an entry two routes share, an entry
missing from the union, a `logger.error` in a `catch` with no `errorId`, a
`catch` that answers 500 while logging nothing at all, a hardcoded `F8.` literal
(either quote style), and an exhaustiveness arm that RETURNS instead of throwing.
That last rule exists because the first version of this work stamped 24 routes
with the promise above while ten of them still returned an unlogged 500 from
that arm — the gate vouched for routes it had never looked inside.

### Where the taxonomy does NOT reach

The gate's scope is `admin/renewals/**` ∪ `portal/renewal/**` ∪ anything that
composes `requireRenewalAdminContext`. **The renewals CRON fleet is outside it**
and carries no `errorId` at all — which matters more than the admin routes,
because nobody is watching at 03:00. Enumerate rather than trust this sentence:

```
# F8-adjacent routes the taxonomy does NOT cover
for f in $(find src/app/api/cron/renewals src/app/api/portal/preferences/renewals \
                -name route.ts); do
  rg -q 'errorId' "$f" || echo "$f"
done
```

For those, an `F8.*` rule matches nothing. Pair it with a route-path or
message-text rule until they are migrated (tracked as follow-up, not done here).

An `*.UNEXPECTED` line whose message reads `<entry>: unhandled error kind
'<kind>'` is **not an outage** — it is a use-case error variant this build's
route does not map, i.e. deploy skew. Look for a newer deploy writing a
`Result.error.kind` the running build's `switch` has no arm for.

**Until 2026-09-07 the id lied.** `requireRenewalAdminContext` hardcoded
`F8.ACCEPT_TIER.CONTEXT_RESOLUTION_FAILED` while being composed by 24 routes,
so a session-lookup failure on `mark-paid-offline` — a money path — paged with
an id naming the tier-upgrade accept route. If you are reading logs from
before that date, `F8.ACCEPT_TIER.CONTEXT_RESOLUTION_FAILED` means *some* F8
route, not that one; use `requestId` to find which.

Worth keeping from that change: the routes were found by enumerating on HTTP
**method**, not by name. The hand-written list this section used to carry
named seven state-changing routes and missed `portal/renewal/redeem-link`,
whose POST redeems a one-time renewal link — a write, and the one a member
actually touches.

**What the taxonomy still does NOT give you: metrics.**
`renewals.escalation_task.action_total{outcome="server_error"}` (alarm F8-A8)
is emitted only by `done` / `skip` / `reassign`, and the assignee-lookup catch
inside `reassign` logs its errorId but emits **no** metric, so F8-A8 does not
fire for that one. Every other F8 route is log-only: alert on the errorId, not
on a counter that does not exist.

The `plans_cancel_audit_backfill_required_total` OTel counter (label `audit_error_type ∈ {persist_failed, invalid_payload}`)
backs the audit-backfill SLO. Sum the counter against backfilled audit rows to compute SLO depth.
