# Runbook — `clamav_daemon_down`

**Owner**: Platform on-call
**Severity**: page (US2 image-upload pipeline blocked; member-facing UX falls back to upload-disabled banner)
**Source signal**: `broadcasts.image_scan_duration_ms` p99 > 5000ms over 5 min OR no scan completes within 2 min when uploads are attempted (proxy for daemon-unreachable). Direct signal: alert pipeline scrapes `fly status -a clamav-swecham` and pages on `health-checks=failing` or `state≠started` for > 2 min.
**Audit events**: `broadcast_image_unsafe` (verdict=`error`) accumulates while the daemon is down because the use-case fails-closed per FR-013.
**Last reviewed**: 2026-05-21 (T125 — F7.1a Phase 6 scaffolding)
**Status**: SPEC — operational once T139 (Fly.io ClamAV deploy) lands on ship-day.

---

## Symptom

Member-facing inline-image uploads return the `clamav-unreachable` banner. Backend `scanInlineImageForVirus` use-case fails-closed (verdict=`error`) per FR-013 — bytes never reach Vercel Blob; rejected uploads are not persisted (FR-013 pipeline-order invariant).

## Why this matters

- **Member UX impact**: members composing F7.1a US2 broadcasts cannot embed new inline images while the daemon is down. Already-embedded images on draft broadcasts remain renderable (the allowlist check is server-side and does not re-scan).
- **Security posture**: the pipeline-order invariant (FR-013 / spec § VIII) holds — no bytes leak to storage during the outage. Failure mode is "reject all" (closed), not "accept all" (open).
- **Compliance posture**: the daemon outage does not affect previously-scanned attachments or broadcasts. PDPA/GDPR posture is unchanged.

## Triage steps (in order)

1. **Confirm the daemon is unreachable.**

   ```bash
   fly status -a clamav-swecham
   fly machine list -a clamav-swecham
   fly logs -a clamav-swecham --since=10m
   ```

   Look for `state=stopped` OR `health-checks=failing` OR a crash loop in recent logs (`clamd[1]: exited with status N`).

2. **Restart the affected machine.**

   ```bash
   fly machine restart <machine_id> -a clamav-swecham
   ```

   Wait ~30 seconds, then re-check:

   ```bash
   fly status -a clamav-swecham
   fly logs -a clamav-swecham --since=2m
   ```

   Expected startup sequence:
   - `clamd[1]: ClamAV 1.x.y/...`
   - `clamd[1]: Listening daemon: PID 1`
   - `clamd[1]: TCP: Bound to address 0.0.0.0`

3. **If restart fails or daemon crash-loops: redeploy from current image.**

   ```bash
   fly deploy -a clamav-swecham --image clamav/clamav:stable
   ```

   This forces a clean image pull. If the `clamav/clamav:stable` upstream is itself broken (rare), pin to the most-recent known-good digest from `infra/clamav/Dockerfile` history.

4. **Verify connectivity from the Vercel side.**

   ```bash
   # from a local dev shell with .env.local synced to prod CLAMAV_HOST:
   pnpm verify:clamav
   # expected: "OK — clamd responded with version <X.Y.Z> in <N>ms"
   ```

   If the script reports `ECONNREFUSED` or `ETIMEDOUT`, the daemon is up but the network path is broken. Check Fly.io egress IP allow-list against Vercel build / function environment.

5. **Failover plan if extended outage (> 30 min with no clear remediation).**

   Per the F7.1a kill-switch criteria in `quickstart.md § 9.1` + spec FR-013:

   ```bash
   vercel env add FEATURE_F71A_US2_IMAGES false --scope production
   vercel --prod
   ```

   - Image upload route returns 503 with `clamav-unreachable` banner (already i18n-keyed across EN+TH+SV).
   - Existing broadcasts continue to render embedded images correctly.
   - No data loss — uploads in-flight at the time of the flag-flip return error to the user.

## Decision tree

```
Daemon up after restart?
├── Yes → verify `image_scan_duration_ms` returns to baseline (p95 < 500ms within 15 min). Close incident.
├── No, and `fly deploy` works → close incident; file root-cause analysis ticket if crash-cause was identifiable (OOM, signature corruption, etc.).
├── No, even after redeploy → flip kill-switch (step 5). Engage Fly.io support (`fly platform support`). Escalate to maintainer.
└── Yes, but `image_scan_duration_ms` stays elevated → may indicate signature DB corruption. Switch to `clamav-signature-stale` runbook for diagnosis of the freshclam pipeline.
```

## Re-enabling US2 images after failover

After the daemon is verified healthy AND signature age is < 24h:

1. Set Vercel env var `FEATURE_F71A_US2_IMAGES=true`.
2. Redeploy via `vercel --prod`.
3. Trigger one synthetic image upload from a staff test account → confirm verdict=`clean` and the row persists in `tenant_image_source_allowlist` if relevant.
4. Watch the next 5 production scans on the Vercel Analytics panel `broadcasts_image_scan_duration_ms{verdict=clean}` median.

## Post-incident actions

- Add an entry to `docs/observability/incidents-log.md` (date, duration, root cause, was-failover-used flag).
- If the daemon crashed due to OOM: bump the Fly.io VM `vm.memory` allocation in `infra/clamav/fly.toml` (default 256 MB → 512 MB).
- If repeated crashes (≥ 2 in 30 days): consider adding a Fly.io `auto_restart=true` policy or a secondary VM for failover.

## Related runbooks

- `docs/runbooks/clamav-signature-stale.md` — signature age > 48h
- `docs/runbooks/broadcast-partial-send-recovery.md` — partial-send rate increases if image uploads are retried via different drafts during the outage
- `docs/runbooks/broadcasts-perf-regression.md` — generic F7 perf-regression triage

## Reference

- F7.1a spec FR-013 (ClamAV scan invariant + 5-min timeout + fail-closed)
- F7.1a plan.md § VII (Perf & Observability)
- F7.1a plan.md kill-switch criteria
- `infra/clamav/fly.toml` + `infra/clamav/Dockerfile`
- `src/lib/metrics/broadcasts-f71a.ts` `imageScanDurationMs()`
- `scripts/verify-clamav-connectivity.ts`
