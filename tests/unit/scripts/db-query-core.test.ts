/**
 * `pnpm db:query` — the read-only SQL runner for the dev branch (D-032).
 * The prod-host refusal must fire BEFORE a connection is opened, and the
 * printed rows must never carry a credential-shaped column.
 */
import { describe, expect, it } from 'vitest';
import { openReadOnlyClient, redactRow } from '../../../scripts/lib/db-query-core';

const DEV = 'postgresql://u:p@ep-dev-xyz789.ap-southeast-1.aws.neon.tech/db';
const PROD = 'postgresql://u:p@ep-prod-abc123.ap-southeast-1.aws.neon.tech/db';

describe('openReadOnlyClient', () => {
  it('refuses a blocklisted host before connecting', () => {
    expect(() => openReadOnlyClient(PROD, 'ep-prod-abc123')).toThrow(/ep-prod-abc123/);
  });

  it('refuses when the blocklist is unset — fail closed', () => {
    expect(() => openReadOnlyClient(DEV, undefined)).toThrow(/TEST_DB_HOST_BLOCKLIST/);
  });

  it('names the host it will read, never the URL', async () => {
    const client = openReadOnlyClient(DEV, 'ep-prod-abc123');
    try {
      expect(client.host).toBe('ep-dev-xyz789.ap-southeast-1.aws.neon.tech');
    } finally {
      await client.end();
    }
  });
});

describe('redactRow', () => {
  it('masks credential-shaped columns and keeps the rest', () => {
    expect(
      redactRow({
        id: 1,
        email: 'a@swecham.test',
        password_hash: '$argon2id$x',
        reset_token: 'abc',
        api_secret: 's',
        session_id: 'sid',
        tokenHash: 't',
      }),
    ).toEqual({
      id: 1,
      email: 'a@swecham.test',
      password_hash: '[redacted]',
      reset_token: '[redacted]',
      api_secret: '[redacted]',
      session_id: '[redacted]',
      tokenHash: '[redacted]',
    });
  });

  it('leaves a null credential column null', () => {
    expect(redactRow({ password_hash: null })).toEqual({ password_hash: null });
  });
});
