# F6 Audit Fallback Double Failure — P1 Runbook

**Alert source**: `eventcreate_audit_fallback_double_failure_total` counter increments ≥ 1 in 5-minute window
**Severity**: **P1 — page on-call immediately**
**Last reviewed**: 2026-05-17 (Phase 10 T131)

## What it means

The F6 audit emitter has a dual-write fallback per research.md R6: when the primary `audit_log` INSERT fails (DB unreachable / RLS error / quota exhausted), the emitter falls back to `pino.fatal(...)` to stdout, which Vercel Fluid Compute captures. This counter increments **only when BOTH paths fail** — i.e., the audit row is unwritten AND pino itself crashed or stderr is unwritable.

This is the project's only **forensic-trail-double-loss** alert. A double failure means the security/compliance audit-trail invariant is broken for some non-zero number of events.

## Symptoms

- Vercel alert pages on-call.
- Last 5 minutes shows ≥1 counter increment with `primary_stage` label (one of: `emit | emit_rolled_back | emit_standalone | find_prior_erasure_completion`).
- Possible accompanying Vercel runtime errors: `pino: write failed`, `EPIPE`, or `EBADF`.

## Immediate response (first 15 minutes)

1. **Acknowledge alert + open incident** (Slack #incidents or equivalent).
2. **Verify Postgres reachability**: 
   ```bash
   psql $DATABASE_URL -c "SELECT NOW();"
   ```
   - If fails → Neon Singapore outage / connectivity issue → escalate to Neon status (https://status.neon.tech).
3. **Verify Vercel runtime health**: Vercel dashboard → project → Functions → check function execution status. Any 500/timeout spike?
4. **Check Vercel quota** (Pro plan limits): `audit_log` INSERTs hitting the row-write rate limit. View Vercel function logs filtered to `event:F6_audit_emit_failed`.
5. **Read the pino logs** (if any made it through): Vercel runtime logs for `[F6] *_audit_secondary_tx_failure: true` markers — these tell you exactly which event was lost.

## Most-likely root causes

1. **Neon outage / restart** — primary DB down → emit fails → pino works but the `audit_log` row is unwritten.
2. **Vercel function memory pressure** — pino's internal buffer overflows when log volume spikes. Both emit and pino fail.
3. **stderr/stdout closed mid-request** — Vercel function lifetime ending mid-flight. Both pino write paths fail with EPIPE.
4. **audit_log enum drift** — recent migration added a new event_type literal but ran-out-of-order; existing emit calls fail enum cast.
5. **RLS policy regression** — `chamber_app` role lost INSERT permission on `audit_log` from a misconfigured migration.

## Mitigations

### Immediate (stop the bleeding)

- **Cause (1)**: wait for Neon recovery. F6 webhook ingest will return 503; the `dual-write` is already trying its best. Once DB is back, the pino-stdout log captures (visible in Vercel runtime logs) are the recovery source — DPO/SRE can manually reconstruct missing audit rows from these.
- **Cause (4)/(5)**: roll back the offending migration. `pnpm drizzle-kit migrate` cannot un-do; manually `ALTER TYPE audit_event_type DROP VALUE 'new_value'` if last; otherwise revert via `INSERT` with old enum then drop the new.

### Forensic recovery

For every `primary_stage` value in the alert window, pull pino logs:
```bash
vercel logs <deployment-url> --since=15m | grep audit_secondary_tx_failure
```
For each line:
- Extract `tenantId`, `eventType`, `payload`
- Reconstruct an `audit_log` INSERT using neondb_owner role (BYPASS RLS, last-resort)
- Record the reconstruction in `docs/compliance/incident-log.md`

### Post-incident

- File postmortem within 5 business days.
- If PII was the payload subject → PDPA Section 37 breach notification within 72 hours.

## Verification after mitigation

- Counter `eventcreate_audit_fallback_double_failure_total` flat for 60 minutes.
- Test webhook end-to-end → audit row written + visible in `audit_log`.
- Pino logs no longer carry `audit_secondary_tx_failure: true` markers.

## Why this is P1

Audit-trail integrity is the bedrock of:
- GDPR Article 30 (records of processing activities) — required forensic surface
- PDPA Section 39 (DPO records) — same
- Chamber-OS Constitution Principle VIII (Reliability) — every state change must have an audit row

A double failure breaks this invariant. Even one event loss is regulatory exposure.
