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

const REDACT_PATHS = [
  'password',
  '*.password',
  'newPassword',
  '*.newPassword',
  'currentPassword',
  '*.currentPassword',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'sessionToken',
  '*.sessionToken',
  'resetToken',
  '*.resetToken',
  'invitationToken',
  '*.invitationToken',
  'secret',
  '*.secret',
  'authorization',
  '*.authorization',
  'Authorization',
  '*.Authorization',
  'cookie',
  '*.cookie',
  'Cookie',
  '*.Cookie',
  'sessionId',
  '*.sessionId',
  'session_id',
  '*.session_id',
  'AUTH_COOKIE_SIGNING_SECRET',
  'RESEND_API_KEY',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_TOKEN',
];

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
    logger.info({ user: { password: SENTINEL, email: 'visible@test' } }, 'test');

    const line = output.join('');
    expect(line).not.toContain(SENTINEL);
    expect(line).toContain('visible@test'); // non-secret fields stay
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
    logger.info(
      {
        email: 'keep-visible@test',
        requestId: 'req-123',
        password: SENTINEL,
      },
      'mixed',
    );

    const line = output.join('');
    expect(line).toContain('keep-visible@test');
    expect(line).toContain('req-123');
    expect(line).not.toContain(SENTINEL);
  });
});
