# F8 Renewals — cron-job.org Setup Walkthrough (T277b close)

**Audience**: SweCham operator with cron-job.org dashboard credentials
**Time required**: ~15 minutes per missing job
**Phase 10 close**: This document is the operator-actionable closure for
T277b — replaces the "deferred to operator action" annotation with a
copy-paste step-by-step recipe.

---

## Pre-flight checklist

Before flipping `FEATURE_F8_RENEWALS=true` in production, all 6 F8 cron-job.org
entries MUST be active per `docs/runbooks/cron-jobs.md` § Job catalogue (lines
38-43). Without these, F8 cron coordinators silently do not run after the
flag flip — leaving members in stale state.

| # | Cron-job.org entry | Schedule | Currently configured? |
|---|-------------------|----------|-----------------------|
| 1 | F8 renewal dispatch coordinator | daily 06:00 ICT | (verify in dashboard) |
| 2 | F8 lapse-cycles-on-grace-expiry coordinator | daily 06:30 ICT | (verify in dashboard) |
| 3 | F8 reconcile-pending-reactivations coordinator | daily 07:00 ICT | **(R002 finding — likely missing)** |
| 4 | F8 at-risk recompute coordinator | Sun 02:00 ICT | (verify in dashboard) |
| 5 | F8 tier-upgrade evaluate coordinator | Sun 03:00 ICT | (verify in dashboard) |
| 6 | F8 reconcile-pending-applications | Sat 05:00 ICT | (verify in dashboard) |
| 7 | F8 prune-consumed-tokens | Sat 04:00 ICT | (verify in dashboard) |

**Action**: log in to cron-job.org, list all jobs, mark each row
"configured" or "missing" in the table above. For every missing row,
execute the corresponding § below.

---

## Per-job setup template (use for any missing entry)

For each missing entry, follow this 7-step recipe:

### Step 1 — Open cron-job.org dashboard

```
URL: https://console.cron-job.org/jobs
Login: SweCham operator credentials (1Password vault: "cron-job.org operator")
```

### Step 2 — Click "Create cronjob"

Top-right "+" button → "Create cronjob".

### Step 3 — Fill in the General tab

| Field | Value (copy from `docs/runbooks/cron-jobs.md` setup section per job) |
|-------|----------------------------------------------------------------------|
| Title | `Chamber-OS · F8 <job-name> coordinator` |
| URL | `https://swecham.zyncdata.app/api/cron/renewals/<job-path>-coordinator` |
| Enabled | ✅ (will be checked by default) |
| Save responses | ✅ (helps debugging) |

### Step 4 — Fill in the Schedule tab

| Field | Value (per runbook § Job catalogue table) |
|-------|-------------------------------------------|
| Execution schedule | `Custom` |
| Cron expression | (per runbook — e.g. `0 7 * * *` for reconcile-pending-reactivations) |
| Time zone | `Asia/Bangkok` |

### Step 5 — Fill in the Advanced tab

| Field | Value |
|-------|-------|
| Request method | `POST` |
| Headers | `Authorization: Bearer ${CRON_SECRET}` (from Vercel env var; do NOT paste literal value into the dashboard for screen-share safety — use the dashboard's secret-input field) |
| Treat 3xx as success | OFF |
| Notification on failure | ON (email: ops@swecham.example) |
| Retry on failure | **OFF** (cron coordinators are idempotent + retries cause double-fan-out per cron-jobs.md § Retry policy contract) |

### Step 6 — Save + verify

Click "Create cronjob". The job appears in the list with a green
"Active" indicator.

### Step 7 — Test once

Click the job → "Test run" → verify HTTP 200 + the canonical JSON
response shape per `docs/runbooks/cron-jobs.md` (per-tenant-results
structure with `tenants_succeeded` + `tenants_failed` fields).

If the test returns 401: re-check the Bearer header (must use the LIVE
`CRON_SECRET` from Vercel production env, not staging or rotated value).
If 503: F8 may be in `READ_ONLY_MODE` — confirm with deployment status.
If 5xx: check Vercel logs for the cron route handler.

---

## Specific job: F8 reconcile-pending-reactivations (R002 finding)

This is the entry most likely missing per `/speckit.staff-review.run`
Wave K23 R002 finding. Without it, FR-005c (30-day pending_admin_reactivation
auto-timeout) silently does not run after `FEATURE_F8_RENEWALS=true` flip
— leaving members in pending state indefinitely.

Use the per-job template above with these values:

| Field | Value |
|-------|-------|
| Title | `Chamber-OS · F8 reconcile-pending-reactivations coordinator` |
| URL | `https://swecham.zyncdata.app/api/cron/renewals/reconcile-pending-reactivations-coordinator` |
| Schedule | `0 7 * * *` (daily 07:00 Asia/Bangkok) |
| Timeout | 30 seconds |

After Step 7 test-run succeeds, paste the cron-job.org job ID (from the
URL bar `console.cron-job.org/jobs/<JOBID>`) into this section + commit:

```
F8 reconcile-pending-reactivations cron-job.org JOB_ID: ____________ (filled by operator at setup time)
```

Then flip `[ ] T277b` → `[X] T277b` in `specs/011-renewal-reminders/tasks.md`
with the JOB_ID + setup timestamp in the closure annotation.

---

## Verification: are all 6 F8 jobs active?

After all setups complete, run this from the dashboard "Jobs" filter:

```
Filter: title contains "F8"
Expected count: 7 jobs (matching the table above row counts)
All Status: Active
```

If count is < 7: identify the missing job by name + create per template.
If a job shows status "Failed" with consecutive errors: investigate
per `docs/runbooks/cron-jobs.md` § Per-job on-call response.

---

## Rollback (if F8 needs disabling post-launch)

Setting `FEATURE_F8_RENEWALS=false` in Vercel env causes ALL cron
coordinators to early-return 200 `{skipped: true, reason: 'kill_switch_disabled'}`
per F8 spec FR-052. The cron-job.org entries can stay active —
they'll just no-op until the flag flips back. **Do NOT delete the jobs**
during a rollback; just flip the env var.

For full removal at end of F8 epic life, use cron-job.org's "Delete job"
action per row.
