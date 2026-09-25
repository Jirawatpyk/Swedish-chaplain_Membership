/**
 * ROUND-2 R-M2 + S-4 + L-2 — the shape of `isBlobReferencedByContent`'s SQL.
 *
 * It was three leading-wildcard `LIKE '%' || url || '%'` predicates, issued
 * once per swept row. Two problems, one statement:
 *
 *   - S-4 (correctness): `%` and `_` are LIKE METACHARACTERS and the URL was
 *     interpolated unescaped. A blob key containing `_` matched any single
 *     character in that position, so the sweep could conclude "still
 *     referenced" about a DIFFERENT image and keep bytes it should have
 *     reclaimed — or, with the operands the other way round, miss one.
 *   - R-M2 / L-2 (cost): a leading wildcard cannot use an index, so every
 *     swept row drove a sequential scan of `broadcasts` and
 *     `broadcast_templates`, with the whole `body_html` of each row read.
 *
 * `position(url in body_html) > 0` is exact substring containment with no
 * pattern semantics at all, which fixes the correctness half outright and
 * removes the escaping question. The scan is still a scan — the follow-up is
 * a pg_trgm GIN index on `body_html`, recorded in the adapter's docblock.
 *
 * Asserting on the SQL TEXT is the point: the behavioural arm lives in the
 * live-Neon lifecycle suite, and a fake repo cannot tell `LIKE` from
 * `position(` — which is exactly how the metacharacter bug survived.
 */
import { describe, expect, it, vi } from 'vitest';
import { drizzleBroadcastImagesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcast-images-repo';
import { CLOSED_NEVER_SENT_BROADCAST_STATUSES } from '@/modules/broadcasts/domain/stage/in-progress-statuses';

/** The text of a drizzle sql template (nested fragments included) — enough to assert WHICH operator ran. */
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: readonly unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) => {
      if (typeof c === 'object' && c !== null && 'value' in c) return (c as { value: readonly string[] }).value.join('');
      if (typeof c === 'object' && c !== null && 'queryChunks' in c) return sqlText(c);
      return ' ? ';
    })
    .join('');
}

const TENANT = 'tenant-swe' as never;
const URL_WITH_METACHARS =
  'https://assets.swecham.zyncdata.app/broadcasts/images/tenant-swe/a_b%c.png';

function recordingTx(): { tx: unknown; statements: unknown[] } {
  const statements: unknown[] = [];
  return {
    statements,
    tx: {
      execute: vi.fn(async (q: unknown) => {
        statements.push(q);
        return [] as unknown;
      }),
    },
  };
}

describe('drizzleBroadcastImagesRepo.isBlobReferencedByContent — SQL shape', () => {
  it('uses exact substring containment, never a LIKE pattern the URL can inject metacharacters into', async () => {
    const { tx, statements } = recordingTx();

    await drizzleBroadcastImagesRepo.isBlobReferencedByContent(TENANT, URL_WITH_METACHARS, tx);

    expect(statements).toHaveLength(1);
    const text = sqlText(statements[0]);
    expect(text).toContain('position(');
    // No LIKE anywhere: a URL carrying `_` or `%` must not be read as a
    // pattern, and there is no escaping to get wrong if there is no pattern.
    expect(text).not.toMatch(/\bLIKE\b/i);
    // All three places a blob URL can appear in live content are still checked.
    expect(text).toContain('body_html');
    expect(text).toContain('body_source');
    expect(text).toContain('broadcast_templates');
  });

  /**
   * T081 follow-up — a rejected / withdrawn / expired E-Blast keeps its body
   * (immutable after submit), so if its OWN content counted, the sweep would
   * restore every image T081 stamped. The exclusion is the Domain constant's
   * statuses plus "never handed over"; versions are scanned through their
   * owner with the same exclusion, or a rejected E-Blast's sent version would
   * re-retain the image.
   */
  it('excludes closed-never-sent owners, and scans version bodies through their owner with the same rule', async () => {
    const { tx, statements } = recordingTx();

    await drizzleBroadcastImagesRepo.isBlobReferencedByContent(TENANT, URL_WITH_METACHARS, tx);

    const text = sqlText(statements[0]);
    expect(text).toContain('broadcast_versions');
    for (const status of CLOSED_NEVER_SENT_BROADCAST_STATUSES) expect(text).toContain(`'${status}'`);
    expect(text).toContain('sending_started_at IS NULL');
    expect(text).toContain('resend_broadcast_id IS NULL');
    expect(text).toContain('audience_import_id IS NULL');
  });

  it('binds the URL as a PARAMETER, never concatenated into the statement text', async () => {
    const { tx, statements } = recordingTx();

    await drizzleBroadcastImagesRepo.isBlobReferencedByContent(TENANT, URL_WITH_METACHARS, tx);

    expect(sqlText(statements[0])).not.toContain(URL_WITH_METACHARS);
  });
});
