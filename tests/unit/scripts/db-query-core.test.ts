/**
 * `pnpm db:query` — the read-only SQL runner for the dev branch (D-032).
 * The prod-host refusal must fire BEFORE a connection is opened, and the
 * printed rows must never carry a credential-shaped column.
 */
import { describe, expect, it } from 'vitest';
import {
  openReadOnlyClient,
  redactRow,
  redactText,
  secretTableRefusal,
  sessionOptions,
} from '../../../scripts/lib/db-query-core';

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

describe('secretTableRefusal', () => {
  it.each(['sessions', 'password_reset_tokens', 'email_change_tokens', 'consumed_link_tokens', 'invitations'])(
    'refuses a statement naming %s, in any case or quoting',
    (table) => {
      expect(secretTableRefusal(`select * from public."${table.toUpperCase()}" limit 1`)).toMatch(table);
    },
  );

  it('passes a statement that only names a similar word', () => {
    expect(secretTableRefusal("SELECT session_count, invitations_sent FROM member_stats")).toBeNull();
  });
});

describe('redactText', () => {
  const HEX = 'a'.repeat(64);

  it('masks a 40+ hex run (a token or its hash) inside any value', () => {
    expect(redactText(`{"h":"${HEX}"}`)).toBe('{"h":"[redacted]"}');
  });

  it('masks the token segment of a reset or invite link', () => {
    expect(redactText('https://x.test/reset-password/abc%2Fdef?x=1')).toBe('https://x.test/reset-password/[redacted]?x=1');
    expect(redactText('https://x.test/invite/Zq9-_x')).toBe('https://x.test/invite/[redacted]');
  });

  it('masks token-named query parameters', () => {
    expect(redactText('https://x.test/a?token=abc&code=123&page=2')).toBe(
      'https://x.test/a?token=[redacted]&code=[redacted]&page=2',
    );
  });

  it('leaves a UUID alone', () => {
    const id = '9d162f25-b6b8-48ad-bca2-2a5f6c689c2c';
    expect(redactText(id)).toBe(id);
  });
});

describe('sessionOptions', () => {
  const FLAGS = '-c default_transaction_read_only=on -c statement_timeout=30000';

  it('sets the read-only default and the timeout', () => {
    expect(sessionOptions(DEV)).toBe(FLAGS);
  });

  it("keeps the URL's own options (Neon's endpoint id) in front of them", () => {
    expect(sessionOptions(`${DEV}?options=endpoint%3Dep-dev-xyz789`)).toBe(`endpoint=ep-dev-xyz789 ${FLAGS}`);
  });

  it('sends no flags to the pooler, which refuses the options parameter', () => {
    expect(sessionOptions('postgresql://u:p@ep-dev-xyz789-pooler.ap-southeast-1.aws.neon.tech/db')).toBe('');
  });
});
