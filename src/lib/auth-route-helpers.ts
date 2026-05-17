/**
 * O3 (Round 3) — Shared parse-or-link-invalid helper for route
 * handlers that accept a URL token (e.g., `/api/auth/reset-password`,
 * `/api/auth/redeem-invite`).
 *
 * Pre-O3 each route duplicated a 12-line `try { parse... } catch
 * (MalformedTokenError) { log + 410 }` block. This helper extracts
 * the shape so a future third route (F3 email-change-revert when
 * it adopts the per-purpose brand) becomes a one-line call.
 *
 * S5 (Round 4) — the discriminator was switched from `ok: boolean`
 * to a literal `kind: 'parsed' | 'link-invalid'` so a future third
 * variant (e.g. an internal-error branch) becomes a compile-time
 * exhaustiveness check instead of a runtime fall-through.
 *
 * The helper returns a discriminated union so the caller pattern is:
 *
 *     const parsed = parseTokenOrLinkInvalid(parse, raw, ctx);
 *     if (parsed.kind === 'link-invalid') return parsed.response;
 *     const token = parsed.value;
 */
import { NextResponse } from 'next/server';
import { MalformedTokenError } from '@/modules/auth';
import { logger } from '@/lib/logger';

export type ParseTokenResult<T> =
  | { readonly kind: 'parsed'; readonly value: T }
  | { readonly kind: 'link-invalid'; readonly response: NextResponse };

export interface ParseTokenContext {
  readonly requestId: string;
  readonly routeName: string;
}

export function parseTokenOrLinkInvalid<T>(
  parse: (raw: string) => T,
  raw: string,
  ctx: ParseTokenContext,
): ParseTokenResult<T> {
  try {
    return { kind: 'parsed', value: parse(raw) };
  } catch (err) {
    if (err instanceof MalformedTokenError) {
      logger.warn(
        { requestId: ctx.requestId, reason: 'malformed-token' },
        `${ctx.routeName}.link-invalid`,
      );
      return {
        kind: 'link-invalid',
        response: NextResponse.json({ error: 'link-invalid' }, { status: 410 }),
      };
    }
    throw err;
  }
}
