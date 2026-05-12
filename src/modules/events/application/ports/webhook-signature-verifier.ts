/**
 * T027 — `WebhookSignatureVerifier` Application port (F6).
 *
 * Verifies the HMAC-SHA256 signature on an inbound webhook delivery
 * per FR-002 + research.md R2. The Infrastructure adapter
 * (`crypto-webhook-signature-verifier.ts`, Phase 3 T044) wraps Node's
 * `crypto.timingSafeEqual` + standard library SHA-256.
 *
 * Generic 401 outcome: ALL failure modes (wrong secret / tampered body
 * / missing header / timestamp skew >5min / length mismatch) return the
 * SAME `VerifyFailure` discriminator so the response body cannot leak
 * which failure path triggered. The audit log carries the discriminator
 * (security.md threat model) but the HTTP body is opaque.
 *
 * Grace-secret fallback: when `gracePresent === true` AND the active
 * secret verify fails, the verifier tries the grace secret. On grace
 * success, the result includes `usedGraceSecret: true` — the use-case
 * emits a `webhook_secret_grace_used` audit IN ADDITION to the success
 * outcome.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import type {
  WebhookSecret,
} from '../../domain/branded-types';

/**
 * Input envelope for a single verify call. The route handler reads raw
 * body BEFORE any parse (Node runtime; not Edge) so `rawBody` is the
 * exact byte sequence Zapier signed. Header values are normalised to
 * lowercase per Node convention.
 */
export interface VerifyInput {
  readonly rawBody: string;
  readonly signatureHeader: string | null; // X-Chamber-Signature
  readonly timestampHeader: string | null; // X-Chamber-Timestamp
  readonly activeSecret: WebhookSecret;
  /**
   * Optional grace secret + rotation timestamp. When the grace window
   * is active (graceRotatedAt within 24h of now per FR-008 + R7), the
   * verifier tries the grace secret on active-secret mismatch.
   */
  readonly graceSecret: WebhookSecret | null;
  readonly graceRotatedAt: Date | null;
  /** Injected for deterministic testing — replaces `new Date()` inside. */
  readonly now: Date;
  /** 5-minute window per FR-002 / security.md. */
  readonly maxSkewSeconds: number;
}

export interface VerifySuccess {
  readonly verified: true;
  readonly usedGraceSecret: boolean;
}

export type VerifyFailureKind =
  | 'missing_signature_header'
  | 'missing_timestamp_header'
  | 'malformed_timestamp'
  | 'timestamp_skew_exceeded'
  | 'signature_mismatch';

export interface VerifyFailure {
  readonly verified: false;
  readonly kind: VerifyFailureKind;
  /**
   * Skew in seconds — populated only when kind ===
   * 'timestamp_skew_exceeded'. Otherwise null. Useful for the audit
   * `webhook_replay_rejected` payload (contracts/audit-port.md § 1).
   */
  readonly skewSeconds: number | null;
}

export type VerifyOutcome = VerifySuccess | VerifyFailure;

export interface WebhookSignatureVerifier {
  verify(input: VerifyInput): Result<VerifyOutcome, never>;
}
