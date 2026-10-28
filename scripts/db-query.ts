// `pnpm db:query "<one SQL statement>"` — run one read-only statement against
// the DEV branch and print the rows as JSON lines (D-032).
//
// The connection string reaches this process through `--env-file=.env.local`
// in package.json, so it never passes through a typed command. Guards and
// their limits are in scripts/lib/db-query-core.ts. There is deliberately no
// `:prod` variant.
import { openReadOnlyClient, redactRow, redactText } from './lib/db-query-core';

/** Rows printed before the output is cut; the total is always reported. */
const MAX_PRINTED_ROWS = 200;

async function main(): Promise<void> {
  const text = process.argv.slice(2).join(' ').trim();
  if (text === '') {
    console.error('usage: pnpm db:query "<one SQL statement>"');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('db:query: DATABASE_URL is required');
    process.exit(1);
  }

  const client = openReadOnlyClient(url, process.env.TEST_DB_HOST_BLOCKLIST);
  console.log(`Target host: ${client.host} (read-only)`);
  if (!process.env.DATABASE_URL_UNPOOLED) {
    console.log('Pooled URL: no session read-only default and no statement timeout; BEGIN READ ONLY still applies.');
  }
  try {
    const rows = await client.query(text);
    for (const row of rows.slice(0, MAX_PRINTED_ROWS)) console.log(redactText(JSON.stringify(redactRow(row))));
    const cut = rows.length > MAX_PRINTED_ROWS ? ` (first ${MAX_PRINTED_ROWS} printed)` : '';
    console.log(`${rows.length} row(s)${cut}`);
  } finally {
    await client.end();
  }
}

main().catch((e: unknown) => {
  console.error(`db:query failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
