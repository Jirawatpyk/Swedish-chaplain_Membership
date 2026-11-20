/**
 * #739 B3a — migration 0330's keep-patterns, read from the migration file and
 * evaluated by live Postgres (POSIX ARE: the em dash literal, the bracket
 * classes), against the values the code writes now (kept) and the text it
 * used to write (rewritten). The relay also counts the rows before and after
 * `pnpm db:migrate` on the dev branch.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db } from '@/lib/db';

const read = (file: string): string => readFileSync(join(process.cwd(), 'drizzle/migrations', file), 'utf8');
const migration = read('0330_redact_stored_error_text.sql');

/** The `!~ '<pattern>'` of the UPDATE on `column`. */
function keepPattern(column: string, source: string = migration): string {
  const re = new RegExp(`"${column}" !~ '([^']+)'`);
  const m = re.exec(source);
  if (m?.[1] === undefined) throw new Error(`no keep-pattern for ${column}`);
  return m[1];
}

// #739 B3b part 2 — 0331 repeats 0330's UPDATEs for the rows the old
// deployment wrote during #800's deploy window: the same statements, so the
// keep-patterns below hold for both.
describe('migration 0331 repeats 0330', () => {
  it('has the same UPDATE statements', () => {
    const statements = (s: string): string =>
      s
        .split('\n')
        .filter((l) => !l.startsWith('--') && l.trim() !== '')
        .join('\n');
    expect(statements(read('0331_redact_stored_error_text_again.sql'))).toBe(statements(migration));
    for (const column of ['receipt_pdf_last_error', 'last_error', 'failure_reason']) {
      expect(keepPattern(column, read('0331_redact_stored_error_text_again.sql'))).toBe(keepPattern(column));
    }
  });
});

async function kept(column: string, value: string): Promise<boolean> {
  const rows = await db.execute<{ keep: boolean }>(
    sql`SELECT (${value}::text ~ ${keepPattern(column)}) AND position('@' IN ${value}::text) = 0 AS keep`,
  );
  return rows[0]?.keep === true;
}

describe('migration 0330 keep-patterns (live Postgres)', () => {
  it('invoices.receipt_pdf_last_error keeps closed codes and rewrites error text', async () => {
    for (const v of ['render:TypeError', 'upload:TypeError:ECONNRESET', 'annotation_render:Error', 'receipt_doc_num_missing']) {
      expect(await kept('receipt_pdf_last_error', v), v).toBe(true);
    }
    for (const v of ['Error: Failed query: … params: a@b.example', 'render: TypeError: x', 'receipt_doc_num_missing — paid row has neither']) {
      expect(await kept('receipt_pdf_last_error', v), v).toBe(false);
    }
  });

  it('notifications_outbox.last_error keeps codes and the gate skip lines the reader matches', async () => {
    for (const v of [
      'resend:invalid-recipient',
      'render:Error',
      'missing_tenant_id',
      'receipt_pdf_gate_skip:invoice_void — the invoice is void; the paid-receipt email is not sent',
      'receipt_pdf_render_skip:invoice_void — the invoice is void; its receipt is not rendered',
    ]) {
      expect(await kept('last_error', v), v).toBe(true);
    }
    for (const v of ['Invalid `to` field.', 'Error: boom', 'resend:x — Anna Svensson', 'resend:invalid-recipient a@b.example']) {
      expect(await kept('last_error', v), v).toBe(false);
    }
  });

  it('renewal_reminder_events.failure_reason keeps codes and rewrites gateway text', async () => {
    for (const v of ['dispatcher_crash:Error', 'dispatcher_crash:legacy_redacted', 'resend:validation_error', 'send:TypeError', 'exhausted_retries']) {
      expect(await kept('failure_reason', v), v).toBe(true);
    }
    for (const v of ['Invalid [REDACTED_EMAIL]', 'upstream timeout', 'dispatcher_crash: duplicate key']) {
      expect(await kept('failure_reason', v), v).toBe(false);
    }
  });
});
