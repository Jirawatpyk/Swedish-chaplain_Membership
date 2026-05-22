# ClamAV ↔ Vercel Connectivity Design (Option D — HTTP scan-wrapper)

**Status**: Implementing 2026-05-22 · F7.1b scope · Gate for T145 (US2 production flip)
**Author**: ship-day deploy session (T139 follow-up)

## Problem

US2 inline-image upload scans member-supplied bytes with ClamAV before
they reach Vercel Blob (FR-013, fail-closed). The ClamAV daemon runs on
Fly.io (`clamav-swecham`, `sin`) reachable only over Fly's **6PN private
network** (`clamav-swecham.internal`, IPv6-only). The Chamber-OS app runs
on **Vercel**, which is not on Fly 6PN and cannot run a persistent
WireGuard/Tailscale tunnel from its serverless runtime. So a Vercel
function cannot reach `clamav-swecham.internal` directly — the original
raw-TCP `clamscan` adapter would always return `error` in production.

## Options considered

| Option | Verdict | Reason |
|---|---|---|
| B. WireGuard from Vercel into 6PN | ❌ | Vercel serverless can't run a persistent WG daemon (ephemeral, no NET_ADMIN). |
| C. Flycast / `.internal` | ❌ | Still requires the caller to be on 6PN. |
| E. Managed scan API (Cloudmersive/VT) | ❌ | Rejected in plan.md Q2 — per-scan cost + sends member content to a third party. |
| F. Public IP + Vercel egress allowlist | ❌ | Vercel egress IPs are dynamic on Pro; stable egress needs Enterprise Secure Compute. |
| A. Public raw TCP + TLS/mTLS | ⚠️ | `clamscan` npm has no TLS/auth — needs stunnel/mTLS; awkward. |
| **D. HTTP scan-wrapper + public HTTPS + bearer** | ✅ **chosen** | Fly edge terminates TLS; bearer auth in HTTP layer; clamd stays localhost (smaller attack surface than the current 6PN-exposed daemon). |

## Chosen architecture

```
Vercel function (clamav-virus-scanner.ts)
  │  HTTPS POST  ${CLAMAV_SCAN_URL}   (e.g. https://clamav-swecham.fly.dev/scan)
  │  Authorization: Bearer ${CLAMAV_SCAN_SECRET}
  │  Content-Type: application/octet-stream
  │  body: raw image bytes (≤ 5.5 MB)
  ▼
Fly edge  ──TLS termination (force_https)──►  scan-server.mjs : 8080  (in the Fly app)
                                                 1. method=POST, path=/scan else 404/405
                                                 2. constant-time bearer check → 401 on mismatch
                                                 3. body cap 5.5 MB (413 over)
                                                 4. clamd INSTREAM via 127.0.0.1:3310 (raw net socket)
                                                 5. JSON { verdict, signature?, durationMs }
                                                 ▼
                                               clamd 127.0.0.1:3310  (localhost-ONLY)
```

`scan-server.mjs` is pure Node (`http` + `net` + `crypto`) — **zero npm
deps** — and speaks the clamd `INSTREAM` wire protocol directly
(`nINSTREAM\n` → `<uint32 len><chunk>…` → `<uint32 0>` → read
`stream: OK` / `stream: <SIG> FOUND`). The `clamscan` npm dependency is
removed from the Vercel app entirely; the app now only does `fetch()`.

## Verdict mapping (preserves `VirusScannerPort` / FR-013)

| HTTP wrapper result | adapter → `VirusScanVerdict` |
|---|---|
| 200 `{verdict:"clean"}` | `{ verdict: 'clean' }` |
| 200 `{verdict:"infected", signature}` | `{ verdict: 'infected', signature }` |
| 200 `{verdict:"error", reason}` | `{ verdict: 'error', reason }` |
| 401 / 403 | `{ verdict: 'error', reason: 'daemon_error', detail: 'auth' }` |
| 413 (too large) | `{ verdict: 'error', reason: 'daemon_error', detail: 'payload_too_large' }` |
| fetch AbortError (timeout) | `{ verdict: 'timeout' }` |
| network error (ECONNREFUSED/ENOTFOUND/…) | `{ verdict: 'error', reason: 'unreachable' }` |
| `CLAMAV_SCAN_URL` empty | `{ verdict: 'error', reason: 'unconfigured' }` |

Adapter still **never throws** — every failure is a typed verdict, and
the use-case (`upload-inline-image.ts`) treats `error`/`timeout` as
fail-closed (reject the upload).

## Config (env.ts)

| Var | Purpose | Default |
|---|---|---|
| `CLAMAV_SCAN_URL` | full HTTPS endpoint of the wrapper (`https://<app>.fly.dev/scan`) | `''` (empty ⇒ `unconfigured`) |
| `CLAMAV_SCAN_SECRET` | bearer token (≥32 bytes); MUST match the Fly app's `CLAMAV_SCAN_SECRET` secret | `''` |
| `CLAMAV_TIMEOUT_MS` | fetch timeout (AbortController) — reused, default 50s | `50000` |
| `CLAMAV_HOST` / `CLAMAV_PORT` | **legacy** — retained for the resolver + dev notes; no longer used by the adapter | — |

Dev: build + run the wrapper image locally (`docker build infra/clamav -t clamav-local && docker run -p 8080:8080 -e CLAMAV_SCAN_SECRET=dev-secret-32-bytes-min-padding clamav-local`), set `CLAMAV_SCAN_URL=http://localhost:8080/scan`.

## Fly app changes (infra/clamav)

- `Dockerfile`: install Node; copy `scan-server.mjs`; start BOTH clamd
  and the wrapper (process supervisor / `&`); revert clamd `TCPAddr` to
  `127.0.0.1` + `::1` (localhost-only — the wrapper is the only client).
- `fly.toml`: replace the raw `internal_port = 3310` service with
  `internal_port = 8080`, `handlers = ["tls","http"]`, `force_https`,
  ports 80→redirect / 443; health check `GET /healthz`. Allocate a
  public address: `fly ips allocate-v6` (+ `fly ips allocate-v4 --shared`).
- New Fly secret: `fly secrets set CLAMAV_SCAN_SECRET=$(openssl rand -base64 48) -a clamav-swecham`.

## Security

- **Transit**: HTTPS (Fly edge TLS) — member image bytes encrypted end-to-end.
- **Auth**: bearer `CLAMAV_SCAN_SECRET`, `crypto.timingSafeEqual` — mismatch → 401.
- **clamd exposure**: localhost-only (no 6PN, no public) — strictly smaller attack surface than the prior 6PN-exposed daemon.
- **DoS bound**: wrapper rejects bodies > 5.5 MB (413) and non-POST/non-`/scan` (404/405) before touching clamd.
- **Fail-closed**: any wrapper error/timeout → adapter `error`/`timeout` → upload rejected (no quarantine bypass).

## Cost

- Dominant cost is the always-on 2 GB Fly machine (~$10-15/mo) — unchanged by Option D.
- Public IPv6 + shared IPv4: free. (Dedicated IPv4 ~$2/mo only if shared proves insufficient.)
- Vercel: ~one extra ~450 ms mostly-idle fetch per image upload — negligible at SweCham broadcast volume.

## Out of scope / follow-ups

- Removing the `clamscan` npm dep + its ESLint `no-restricted-imports` rule from the app (the adapter no longer imports it). Tracked as a cleanup; left in place this pass to bound blast radius.
- Multi-region ClamAV (latency) — `clamav-endpoint-resolver.ts` retains the mode classifier for a future iteration.
