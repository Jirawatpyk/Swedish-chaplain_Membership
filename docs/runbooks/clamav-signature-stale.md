# Runbook — `clamav_signature_stale`

**Owner**: Platform on-call
**Severity**: page (security control degraded — image scans run against stale signature DB)
**Source signal**: `broadcasts.clamav_signature_age_hours` observable gauge > 48
**Audit events**: `broadcast_image_unsafe` (verdict=`error`) may co-occur if scan results unreliable
**Last reviewed**: 2026-05-21 (T124 — F7.1a Phase 6 scaffolding)
**Status**: SPEC — operational once T139 (Fly.io ClamAV deploy) lands on ship-day.

---

## Symptom

The async observable gauge `broadcasts.clamav_signature_age_hours` exceeded 48 hours, meaning the most-recent ClamAV signature DB load happened > 2 days ago. The gauge is probed hourly by `scripts/probe-clamav-signature-age.ts` (cron-job.org coordinator) via the `CLAMD VERSION` socket call against the Fly.io daemon.

## Why this matters

- F7.1a US2 inline images bypass the safe-list once they reach the scan step. If signatures are stale, newly published malware patterns are not detected — members could upload+embed infected images that the platform certifies as clean.
- Compliance impact: tenant trust relies on the F7.1a security narrative (Constitution Principle I sub-clause 4 + spec FR-013 pipeline-order invariant). A page is appropriate because the control failure is silent — the scan still returns `clean` against an outdated signature set.
- The `freshclam` daemon inside the Fly.io VM is responsible for pulling new signatures. The VM is single-region (`sin`), so a daemon-side regression does not have automatic failover.

## Triage steps (in order)

1. **Check Fly.io machine status.**

   ```bash
   fly status -a clamav-swecham
   fly machine list -a clamav-swecham
   ```

   Look for `state=started` AND `health-checks=passing`. If the machine is `stopped` or `unhealthy`, escalate to the `clamav_daemon_down` runbook first — that path is unreachable when the daemon itself is offline.

2. **SSH into the VM and inspect freshclam.**

   ```bash
   fly ssh console -a clamav-swecham
   # inside the container:
   freshclam --debug
   ls -lh /var/lib/clamav/*.cvd /var/lib/clamav/*.cld
   ```

   Common findings:
   - `daily.cvd` or `daily.cld` modified-time > 48h → freshclam stopped polling. Check the freshclam logs at `/var/log/clamav/freshclam.log`.
   - `WARNING: getpatch: Can't download daily-XXX.cdiff` → upstream mirror flap; usually self-heals on next poll.
   - `ERROR: NotAllowed` → ClamAV mirror blocked the IP. Cloudflare / Fly.io egress IP may be rate-limited.

3. **Force an immediate signature refresh.**

   ```bash
   # inside the container:
   freshclam --no-warnings
   # then verify:
   clamscan --version
   # expected: "ClamAV 1.x.y/<sig_version>/<recent ISO timestamp>"
   ```

   If `freshclam` reports success, the gauge will refresh on the next probe tick (within 1 hour). Manually re-probe to confirm without waiting:

   ```bash
   pnpm tsx scripts/probe-clamav-signature-age.ts
   # expect: log line "broadcasts.clamav_signature_age_hours observed: <hours>"
   ```

4. **Restart the container if freshclam refuses to run.**

   ```bash
   fly machine restart <machine_id> -a clamav-swecham
   # wait ~30s for clamd + freshclam to bootstrap
   fly logs -a clamav-swecham --since=2m
   ```

   Watch for the `clamd[1]: Listening daemon` startup line and `freshclam[N]: Database updated` follow-up.

5. **Verify scan latency returns to baseline.**

   Open Vercel Analytics → `broadcasts_image_scan_duration_ms{verdict=clean}` panel. Median should drop back under 200ms once the daemon picks up the refreshed signature set. If latency stays elevated, the issue is daemon-side, not signature-side — escalate to `clamav_daemon_down`.

## Decision tree

```
Is signature age still > 48h after manual freshclam?
├── Yes, AND clamd is up
│   └── Mirror issue. Escalate to clamav-internal escalation list.
│       Temporary mitigation: flip `FEATURE_F71A_US2_IMAGES=false`
│       per kill-switch criteria; image upload returns 503 with
│       "scanner unavailable" banner already i18n-keyed (US2 work).
├── Yes, AND clamd is down/restart-looping
│   └── Switch to `clamav_daemon_down` runbook.
└── No (refreshed successfully)
    └── Resolve incident. File a follow-up ticket if root cause was
        a mirror-side flap > 1 occurrence in the last 30 days.
```

## Failover (extended outage)

If signature refresh fails for > 4 hours AND there is no clear remediation path within 1 hour:

1. Set Vercel env var `FEATURE_F71A_US2_IMAGES=false` (per `quickstart.md § 9.1`).
2. Redeploy via `vercel --prod` — image upload returns the `clamav-unreachable` banner (3-locale strings already shipped).
3. Existing broadcasts continue to render embedded images correctly (allowlist is enforced server-side; the URLs themselves are not re-scanned at send time).
4. Post-resolution: flip the flag back; signature age gauge should re-converge within 1 probe tick.

## Post-incident actions

- Add a one-line entry to `docs/observability/incidents-log.md` (date, duration, root cause, signature delta).
- If Cloudflare / mirror egress IP was implicated: open a Fly.io ticket to consider region failover (`fra` or `nrt` co-located mirror set).
- Review whether `cron-job.org` probe cadence (hourly) is appropriate — increase to 15-min cadence if recurring.

## Related runbooks

- `docs/runbooks/clamav-daemon-down.md` — when the daemon itself is unreachable
- `docs/runbooks/broadcast-partial-send-recovery.md` — image-upload failure can downgrade a broadcast to partial-send if the member retries via a different draft

## Reference

- F7.1a spec FR-013 (ClamAV scan invariant + 5-min timeout + fail-closed)
- F7.1a plan.md § VII (Perf & Observability — 5 metrics + 4 alerts catalogue)
- `src/lib/metrics/broadcasts-f71a.ts` `clamavSignatureAgeHours()`
- `scripts/probe-clamav-signature-age.ts` (cron-job.org coordinator, hourly)
