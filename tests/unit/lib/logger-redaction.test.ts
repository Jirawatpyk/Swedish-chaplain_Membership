/**
 * T158 — Logger redaction unit test (security.md T-14, FR-012 U2).
 *
 * Proves that the pino logger redacts every secret-bearing field
 * before the serialized line touches a log sink. Every path listed
 * in `src/lib/logger.ts` REDACT_PATHS is exercised at least once
 * with a distinctive sentinel string; the assertions then look for
 * the sentinel in the captured output and fail if any slips through.
 *
 * Uses a custom pino destination (`pino.destination` with a write
 * callback) so we capture the raw JSON output without touching the
 * real stdout stream.
 */
import { describe, expect, it } from 'vitest';
import pino from 'pino';
// R3 — import the canonical REDACT_PATHS from the production logger.
// Previously a copy-paste sat here and had drifted to omit 22 paths;
// the mechanical import closes the drift forever.
import { REDACT_PATHS } from '@/lib/logger';

const SENTINEL = 'SUPER_SECRET_SENTINEL_VALUE_DO_NOT_LEAK';

function makeCapturingLogger(): { logger: pino.Logger; output: string[] } {
  const output: string[] = [];
  const destination = {
    write(chunk: string): void {
      output.push(chunk);
    },
  };
  const logger = pino(
    {
      level: 'debug',
      redact: {
        paths: REDACT_PATHS,
        censor: '[REDACTED]',
        remove: false,
      },
    },
    destination as never,
  );
  return { logger, output };
}

describe('logger redaction (T158, T-14)', () => {
  it('redacts top-level password field', () => {
    const { logger, output } = makeCapturingLogger();
    logger.info({ password: SENTINEL }, 'test');

    const line = output.join('');
    expect(line).not.toContain(SENTINEL);
    expect(line).toContain('[REDACTED]');
  });

  it('redacts nested password field (one level deep)', () => {
    const { logger, output } = makeCapturingLogger();
    // R3 — pair the redacted `password` with a truly-non-sensitive
    // sibling (`userId`). The previous sibling was `email`, but `email`
    // is PDPA-classified and *.email is in REDACT_PATHS; the old
    // assertion passed only because the test file carried a stale
    // copy of REDACT_PATHS that omitted PII fields.
    logger.info({ user: { password: SENTINEL, userId: 'visible-123' } }, 'test');

    const line = output.join('');
    expect(line).not.toContain(SENTINEL);
    expect(line).toContain('visible-123'); // non-secret fields stay
  });

  it('redacts attendeeEmailLower (F6 attendee-import PII) at depths 0–2', () => {
    // P2 Wave-0 — `attendeeEmailLower` is a distinct key from `email`, so the
    // `email`/`*.email` paths do NOT cover it; it needs its own redact paths.
    const { logger, output } = makeCapturingLogger();
    logger.info(
      {
        attendeeEmailLower: `${SENTINEL}-top`,
        ctx: { attendeeEmailLower: `${SENTINEL}-d1` },
        outer: { inner: { attendeeEmailLower: `${SENTINEL}-d2` } },
        nonSecret: 'visible-attendee',
      },
      'test',
    );
    const line = output.join('');
    expect(line).not.toContain(`${SENTINEL}-top`);
    expect(line).not.toContain(`${SENTINEL}-d1`);
    expect(line).not.toContain(`${SENTINEL}-d2`);
    expect(line).toContain('visible-attendee');
  });

  it('redacts newPassword / currentPassword / passwordHash', () => {
    const { logger, output } = makeCapturingLogger();
    logger.info(
      {
        newPassword: `${SENTINEL}-new`,
        currentPassword: `${SENTINEL}-current`,
        passwordHash: `${SENTINEL}-hash`,
      },
      'password fields',
    );

    const line = output.join('');
    expect(line).not.toContain(`${SENTINEL}-new`);
    expect(line).not.toContain(`${SENTINEL}-current`);
    expect(line).not.toContain(`${SENTINEL}-hash`);
  });

  it('redacts generic token field + specific token variants', () => {
    const { logger, output } = makeCapturingLogger();
    logger.info(
      {
        token: `${SENTINEL}-generic`,
        sessionToken: `${SENTINEL}-session`,
        resetToken: `${SENTINEL}-reset`,
        invitationToken: `${SENTINEL}-invite`,
      },
      'tokens',
    );

    const line = output.join('');
    expect(line).not.toContain(`${SENTINEL}-generic`);
    expect(line).not.toContain(`${SENTINEL}-session`);
    expect(line).not.toContain(`${SENTINEL}-reset`);
    expect(line).not.toContain(`${SENTINEL}-invite`);
  });

  it('redacts Authorization and Cookie headers (both casings)', () => {
    const { logger, output } = makeCapturingLogger();
    logger.info(
      {
        headers: {
          authorization: `Bearer ${SENTINEL}`,
          Authorization: `Bearer ${SENTINEL}-alt`,
          cookie: `swecham_session=${SENTINEL}`,
          Cookie: `swecham_session=${SENTINEL}-alt`,
        },
      },
      'headers',
    );

    const line = output.join('');
    expect(line).not.toContain(`Bearer ${SENTINEL}`);
    expect(line).not.toContain(`Bearer ${SENTINEL}-alt`);
    expect(line).not.toContain(`swecham_session=${SENTINEL}`);
  });

  it('redacts sessionId (camelCase and snake_case)', () => {
    const { logger, output } = makeCapturingLogger();
    logger.info(
      { sessionId: `${SENTINEL}-camel`, session_id: `${SENTINEL}-snake` },
      'session ids',
    );

    const line = output.join('');
    expect(line).not.toContain(`${SENTINEL}-camel`);
    expect(line).not.toContain(`${SENTINEL}-snake`);
  });

  it('redacts env-var secrets leaked via logger.info spread', () => {
    const { logger, output } = makeCapturingLogger();
    logger.info(
      {
        AUTH_COOKIE_SIGNING_SECRET: `${SENTINEL}-auth`,
        RESEND_API_KEY: `${SENTINEL}-resend`,
        KV_REST_API_TOKEN: `${SENTINEL}-kv`,
        UPSTASH_REDIS_REST_TOKEN: `${SENTINEL}-upstash`,
      },
      'env spread',
    );

    const line = output.join('');
    expect(line).not.toContain(`${SENTINEL}-auth`);
    expect(line).not.toContain(`${SENTINEL}-resend`);
    expect(line).not.toContain(`${SENTINEL}-kv`);
    expect(line).not.toContain(`${SENTINEL}-upstash`);
  });

  it('does NOT redact non-sensitive fields next to sensitive ones', () => {
    const { logger, output } = makeCapturingLogger();
    // R3 — `email` is PDPA-classified and *IS* in REDACT_PATHS; the
    // non-sensitive sibling must genuinely be outside the redact list.
    // `requestId` + `outcome` are both operational-metadata fields
    // that stay visible by design.
    logger.info(
      {
        outcome: 'keep-visible-status',
        requestId: 'req-123',
        password: SENTINEL,
      },
      'mixed',
    );

    const line = output.join('');
    expect(line).toContain('keep-visible-status');
    expect(line).toContain('req-123');
    expect(line).not.toContain(SENTINEL);
  });

  // F054 — non-member buyer snapshot bare `legal_name` + `address` keys.
  // BuyerSnapshot has these at the object root; no code currently logs
  // the snapshot directly but defence-in-depth should auto-redact if it
  // ever does. Covers depth-0, depth-1, and depth-2 (same convention as
  // `tax_id` / `attendee_email`).
  it('F054: redacts top-level legal_name, address and primary_contact_name', () => {
    const { logger, output } = makeCapturingLogger();
    logger.info(
      {
        legal_name: `${SENTINEL}-legalname`,
        address: `${SENTINEL}-address`,
        primary_contact_name: `${SENTINEL}-contactname`,
      },
      'buyer snapshot top-level',
    );
    const line = output.join('');
    expect(line).not.toContain(`${SENTINEL}-legalname`);
    expect(line).not.toContain(`${SENTINEL}-address`);
    expect(line).not.toContain(`${SENTINEL}-contactname`);
    expect(line).toContain('[REDACTED]');
  });

  it('F054: redacts nested (depth-1) legal_name and address', () => {
    const { logger, output } = makeCapturingLogger();
    logger.info(
      {
        buyer: {
          legal_name: `${SENTINEL}-nested-legalname`,
          address: `${SENTINEL}-nested-address`,
        },
      },
      'buyer snapshot nested',
    );
    const line = output.join('');
    expect(line).not.toContain(`${SENTINEL}-nested-legalname`);
    expect(line).not.toContain(`${SENTINEL}-nested-address`);
    expect(line).toContain('[REDACTED]');
  });

  it('F054: redacts depth-2 legal_name and address (audit-payload shape)', () => {
    const { logger, output } = makeCapturingLogger();
    logger.info(
      {
        audit: {
          payload: {
            legal_name: `${SENTINEL}-deep-legalname`,
            address: `${SENTINEL}-deep-address`,
          },
        },
      },
      'buyer snapshot depth-2',
    );
    const line = output.join('');
    expect(line).not.toContain(`${SENTINEL}-deep-legalname`);
    expect(line).not.toContain(`${SENTINEL}-deep-address`);
    expect(line).toContain('[REDACTED]');
  });

  // R2-I1 — F4 audit payload PII. Classified as PDPA/GDPR Cat-B in
  // `specs/007-invoices-receipts/security.md § 4`. Must NEVER leak to
  // logs even if a caller passes the full audit event object to pino.
  it('redacts top-level + 1-level + 2-level nested `recipient_email`', () => {
    const { logger, output } = makeCapturingLogger();
    logger.info(
      {
        recipient_email: `${SENTINEL}-top@member.test`,
        event: {
          eventType: 'invoice_issued',
          recipient_email: `${SENTINEL}-nested1@member.test`,
          payload: {
            // R3 depth-2 coverage — the audit-emit shape puts
            // `recipient_email` inside `.event.payload.*`. Pino's `*`
            // wildcard matches one intermediate key only; this only
            // passes if REDACT_PATHS includes `*.*.recipient_email`.
            recipient_email: `${SENTINEL}-nested2@member.test`,
          },
        },
      },
      'audit payload',
    );

    const line = output.join('');
    expect(line).not.toContain(`${SENTINEL}-top@member.test`);
    expect(line).not.toContain(`${SENTINEL}-nested1@member.test`);
    expect(line).not.toContain(`${SENTINEL}-nested2@member.test`);
    expect(line).toContain('[REDACTED]');
  });

  // K2 / FR-049 — F8 renewals secrets + tokens + member contact PII.
  // The spec explicitly enumerates 7 forbidden-in-logs paths; each must
  // be redacted at top-level + nested form.
  describe('FR-049 — F8 renewals forbidden-in-logs paths', () => {
    it('redacts renewal_token + nested + camelCase variants', () => {
      const { logger, output } = makeCapturingLogger();
      logger.info(
        {
          renewal_token: `${SENTINEL}-tok`,
          renewalToken: `${SENTINEL}-camel`,
          ctx: { renewal_token: `${SENTINEL}-nested` },
          audit: { payload: { renewal_token: `${SENTINEL}-deep` } },
        },
        'renewal token',
      );
      const line = output.join('');
      expect(line).not.toContain(`${SENTINEL}-tok`);
      expect(line).not.toContain(`${SENTINEL}-camel`);
      expect(line).not.toContain(`${SENTINEL}-nested`);
      expect(line).not.toContain(`${SENTINEL}-deep`);
    });

    it('redacts renewal_link + camelCase + nested', () => {
      const { logger, output } = makeCapturingLogger();
      logger.info(
        {
          renewal_link: `${SENTINEL}-link`,
          renewalLink: `${SENTINEL}-camelLink`,
          email: { renewal_link: `${SENTINEL}-emailLink` },
        },
        'renewal link',
      );
      const line = output.join('');
      expect(line).not.toContain(`${SENTINEL}-link`);
      expect(line).not.toContain(`${SENTINEL}-camelLink`);
      expect(line).not.toContain(`${SENTINEL}-emailLink`);
    });

    it('redacts RENEWAL_LINK_TOKEN_SECRET + lowercase + camelCase', () => {
      const { logger, output } = makeCapturingLogger();
      logger.info(
        {
          RENEWAL_LINK_TOKEN_SECRET: `${SENTINEL}-env`,
          renewal_link_token_secret: `${SENTINEL}-lower`,
          renewalLinkTokenSecret: `${SENTINEL}-camel`,
          env: { renewal_link_token_secret: `${SENTINEL}-nested` },
        },
        'env',
      );
      const line = output.join('');
      expect(line).not.toContain(`${SENTINEL}-env`);
      expect(line).not.toContain(`${SENTINEL}-lower`);
      expect(line).not.toContain(`${SENTINEL}-camel`);
      expect(line).not.toContain(`${SENTINEL}-nested`);
    });

    it('redacts payment_method + camelCase + nested (Stripe defence)', () => {
      const { logger, output } = makeCapturingLogger();
      logger.info(
        {
          payment_method: `${SENTINEL}-pm`,
          paymentMethod: `${SENTINEL}-camelPm`,
          ctx: { payment_method: `${SENTINEL}-nested` },
          audit: { payload: { payment_method: `${SENTINEL}-deep` } },
        },
        'payment method',
      );
      const line = output.join('');
      expect(line).not.toContain(`${SENTINEL}-pm`);
      expect(line).not.toContain(`${SENTINEL}-camelPm`);
      expect(line).not.toContain(`${SENTINEL}-nested`);
      expect(line).not.toContain(`${SENTINEL}-deep`);
    });

    it('redacts primary_contact_email + camelCase + nested', () => {
      const { logger, output } = makeCapturingLogger();
      logger.info(
        {
          primary_contact_email: `${SENTINEL}-pce@x.test`,
          primaryContactEmail: `${SENTINEL}-camelPce@x.test`,
          member: { primary_contact_email: `${SENTINEL}-nested@x.test` },
          audit: { payload: { primary_contact_email: `${SENTINEL}-deep@x.test` } },
        },
        'primary contact',
      );
      const line = output.join('');
      expect(line).not.toContain(`${SENTINEL}-pce@x.test`);
      expect(line).not.toContain(`${SENTINEL}-camelPce@x.test`);
      expect(line).not.toContain(`${SENTINEL}-nested@x.test`);
      expect(line).not.toContain(`${SENTINEL}-deep@x.test`);
    });

    it('redacts member.email shape (FR-049 explicit nested form)', () => {
      const { logger, output } = makeCapturingLogger();
      logger.info(
        {
          // The `*.email` wildcard already covers `{member: {email}}`;
          // this test pins the FR-049-mandated path explicitly.
          member: { email: `${SENTINEL}-memEmail@x.test` },
        },
        'member email',
      );
      const line = output.join('');
      expect(line).not.toContain(`${SENTINEL}-memEmail@x.test`);
    });
  });

  // F-member-number — spec §9 re-linkable PII.
  // memberNumber + member_number + member_number_display are all re-linkable
  // (number → company identity). companyName is NOT re-classified; it may
  // remain visible so the log entry is still operationally useful.
  it('F-member-number: redacts memberNumber, member_number, member_number_display at depths 0–2', () => {
    const { logger, output } = makeCapturingLogger();
    logger.info(
      {
        memberNumber: `${SENTINEL}-mn`,
        member_number: `${SENTINEL}-mn-snake`,
        member_number_display: `${SENTINEL}-mn-display`,
        companyName: 'Visible Co Ltd', // non-PII sibling — MUST stay
        ctx: {
          memberNumber: `${SENTINEL}-mn-d1`,
          member_number: `${SENTINEL}-mn-snake-d1`,
          member_number_display: `${SENTINEL}-mn-display-d1`,
        },
        audit: {
          payload: {
            memberNumber: `${SENTINEL}-mn-d2`,
            member_number: `${SENTINEL}-mn-snake-d2`,
            member_number_display: `${SENTINEL}-mn-display-d2`,
          },
        },
      },
      'member-number re-linkable PII',
    );
    const line = output.join('');
    // All three field forms at all three depths MUST be redacted.
    expect(line).not.toContain(`${SENTINEL}-mn`);
    expect(line).not.toContain(`${SENTINEL}-mn-snake`);
    expect(line).not.toContain(`${SENTINEL}-mn-display`);
    expect(line).not.toContain(`${SENTINEL}-mn-d1`);
    expect(line).not.toContain(`${SENTINEL}-mn-snake-d1`);
    expect(line).not.toContain(`${SENTINEL}-mn-display-d1`);
    expect(line).not.toContain(`${SENTINEL}-mn-d2`);
    expect(line).not.toContain(`${SENTINEL}-mn-snake-d2`);
    expect(line).not.toContain(`${SENTINEL}-mn-display-d2`);
    // companyName is a non-sensitive sibling — MUST remain visible.
    expect(line).toContain('Visible Co Ltd');
    expect(line).toContain('[REDACTED]');
  });
});
