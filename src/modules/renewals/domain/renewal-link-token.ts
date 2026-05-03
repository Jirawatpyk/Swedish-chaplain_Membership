/**
 * T037 (F8 Phase 2 Wave D) — `RenewalLinkToken` Domain entity.
 *
 * HMAC-signed single-use token payload per research.md R1 + R16
 * (dual-key rotation). The Domain owns the canonical payload shape +
 * structural validation; Application layer's `RenewalLinkTokenSigner`
 * + `Verifier` ports (Wave E T048) handle the HMAC operation +
 * dual-key rotation against `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` /
 * `_FALLBACK` env vars.
 *
 * Token shape (canonical JSON payload before HMAC):
 *   { v, tid, mid, cid, iat, exp }
 *
 * Field abbreviations chosen for compact JSON-string size — token
 * goes in the URL path so brevity matters. Application layer can
 * widen to descriptive names internally; the wire format stays tight.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';

/**
 * Canonical payload version. Signed bytes commit to this so future
 * payload-shape changes can be rolled out via a v=2 with the dual-key
 * rotation window covering both shapes.
 */
export const RENEWAL_LINK_TOKEN_VERSION = 1 as const;

export type RenewalLinkTokenVersion = typeof RENEWAL_LINK_TOKEN_VERSION;

/**
 * 30-day TTL per spec (research.md R1) — matches `consumed_link_tokens`
 * weekly housekeeping prune of rows >60d old (i.e. 30d TTL + 30d
 * lingering single-use replay window).
 */
export const RENEWAL_LINK_TOKEN_TTL_DAYS = 30 as const;
export const RENEWAL_LINK_TOKEN_TTL_SECONDS =
  RENEWAL_LINK_TOKEN_TTL_DAYS * 24 * 60 * 60;

export interface RenewalLinkTokenPayload {
  readonly v: RenewalLinkTokenVersion;
  readonly tid: string;
  readonly mid: string;
  readonly cid: string;
  /** Issued-at, unix epoch seconds. */
  readonly iat: number;
  /** Expires-at, unix epoch seconds. iat + RENEWAL_LINK_TOKEN_TTL_SECONDS. */
  readonly exp: number;
}

export type TokenPayloadError =
  | { readonly kind: 'wrong_version'; readonly raw: unknown }
  | { readonly kind: 'missing_field'; readonly field: keyof RenewalLinkTokenPayload }
  | { readonly kind: 'expired'; readonly expSec: number; readonly nowSec: number }
  | { readonly kind: 'tenant_mismatch'; readonly expected: string; readonly got: string }
  | { readonly kind: 'malformed_iat_exp'; readonly iat: number; readonly exp: number };

interface RawPayload {
  readonly v?: unknown;
  readonly tid?: unknown;
  readonly mid?: unknown;
  readonly cid?: unknown;
  readonly iat?: unknown;
  readonly exp?: unknown;
}

/**
 * Build a fresh payload at signing time. `now` is injected so callers
 * can use a deterministic clock in tests.
 */
export function buildPayload(args: {
  tenantId: string;
  memberId: string;
  cycleId: string;
  now: Date;
}): RenewalLinkTokenPayload {
  const iat = Math.floor(args.now.getTime() / 1000);
  return {
    v: RENEWAL_LINK_TOKEN_VERSION,
    tid: args.tenantId,
    mid: args.memberId,
    cid: args.cycleId,
    iat,
    exp: iat + RENEWAL_LINK_TOKEN_TTL_SECONDS,
  };
}

/**
 * Validate a parsed JSON payload structurally + against expiration +
 * tenant context. Does NOT verify the HMAC — that's the signer/verifier
 * port's job (Wave E T048). Callers run HMAC-verify FIRST, then call
 * this validator on the decoded payload.
 */
export function parsePayload(
  raw: RawPayload,
  ctx: { readonly expectedTenantId: string; readonly now: Date },
): Result<RenewalLinkTokenPayload, TokenPayloadError> {
  if (raw.v !== RENEWAL_LINK_TOKEN_VERSION) {
    return err({ kind: 'wrong_version', raw: raw.v });
  }
  if (typeof raw.tid !== 'string' || raw.tid.length === 0) {
    return err({ kind: 'missing_field', field: 'tid' });
  }
  if (typeof raw.mid !== 'string' || raw.mid.length === 0) {
    return err({ kind: 'missing_field', field: 'mid' });
  }
  if (typeof raw.cid !== 'string' || raw.cid.length === 0) {
    return err({ kind: 'missing_field', field: 'cid' });
  }
  if (typeof raw.iat !== 'number' || !Number.isFinite(raw.iat)) {
    return err({ kind: 'missing_field', field: 'iat' });
  }
  if (typeof raw.exp !== 'number' || !Number.isFinite(raw.exp)) {
    return err({ kind: 'missing_field', field: 'exp' });
  }
  if (raw.exp <= raw.iat) {
    return err({ kind: 'malformed_iat_exp', iat: raw.iat, exp: raw.exp });
  }

  if (raw.tid !== ctx.expectedTenantId) {
    return err({
      kind: 'tenant_mismatch',
      expected: ctx.expectedTenantId,
      got: raw.tid,
    });
  }

  const nowSec = Math.floor(ctx.now.getTime() / 1000);
  if (raw.exp <= nowSec) {
    return err({ kind: 'expired', expSec: raw.exp, nowSec });
  }

  return ok({
    v: RENEWAL_LINK_TOKEN_VERSION,
    tid: raw.tid,
    mid: raw.mid,
    cid: raw.cid,
    iat: raw.iat,
    exp: raw.exp,
  });
}

/** Helper: compute remaining seconds before a payload expires. */
export function secondsUntilExpiry(
  payload: RenewalLinkTokenPayload,
  now: Date,
): number {
  return payload.exp - Math.floor(now.getTime() / 1000);
}
