/**
 * 088 US8 UX-B1 (T061e-1) — invoicing's OWN `VirusScannerPort`.
 *
 * One-method contract for malware-scanning an uploaded MFA §80/1(5) zero-rate
 * certificate scan BEFORE it is retained in Blob (FR-024). The production
 * adapter (`infrastructure/adapters/clamav-virus-scanner.ts`) POSTs the bytes
 * to the same Fly.io ClamAV HTTPS scan-wrapper F7.1a uses, via `env.clamav.*`.
 *
 * WHY a SECOND VirusScannerPort (NOT a reuse of the broadcasts one):
 * Constitution Principle III (NON-NEGOTIABLE) forbids cross-module deep
 * imports — invoicing MUST NOT import
 * `@/modules/broadcasts/application/ports/virus-scanner-port`. The two ports
 * are structurally similar but INDEPENDENTLY OWNED; they share only the
 * `env.clamav.*` transport config (a lib-level, not module-level, dependency),
 * so there is zero coupling. Each module owns its own copy per the barrel rule.
 *
 * Verdict taxonomy (fail-closed — anything except `clean` REJECTS the upload):
 *   - `clean`    — scanned, no signature match → safe to retain
 *   - `infected` — signature matched → reject (`zero_rate_cert_unsafe`)
 *   - `error`    — daemon unreachable / unconfigured / non-scan failure → reject
 *                  (`zero_rate_cert_scan_failed`). When `env.clamav.scanUrl` is
 *                  empty the adapter returns `error` with `reason:'unconfigured'`
 *                  (dev default — cert scan stays OPTIONAL, so a rejected upload
 *                  is acceptable: the cert NUMBER is the fail-closed gate).
 *   - `timeout`  — scan exceeded `env.clamav.timeoutMs` → reject (fail-closed).
 *
 * Pure interface — no framework imports. The adapter NEVER throws; every
 * failure surfaces as a typed verdict so the use-case fails closed without
 * try/catch plumbing.
 */
export type VirusScanVerdict =
  | { readonly verdict: 'clean'; readonly durationMs: number }
  | {
      readonly verdict: 'infected';
      readonly signature: string;
      readonly durationMs: number;
    }
  | {
      readonly verdict: 'error';
      readonly reason: 'unconfigured' | 'unreachable' | 'daemon_error' | 'unknown';
      readonly detail?: string;
      readonly durationMs: number;
    }
  | { readonly verdict: 'timeout'; readonly durationMs: number };

export interface VirusScannerPort {
  /**
   * Scan a byte buffer for known signatures.
   *
   * @param bytes - Certificate bytes (≤5 MB per the use-case cap, but the port
   *                is content-agnostic — size enforcement lives in
   *                `upload-zero-rate-cert.ts`).
   * @returns A verdict + duration. Never throws — all failure modes surface as
   *          `verdict: 'error' | 'timeout'` so the calling use-case can decide
   *          fail-closed handling without try/catch plumbing.
   */
  scan(bytes: Buffer): Promise<VirusScanVerdict>;
}
