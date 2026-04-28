import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

async function main() {
  const c = await db.execute(
    sql`SELECT count(*)::int as count FROM drizzle.__drizzle_migrations`,
  );
  console.log('applied count:', c);
  // Show what is NOT yet applied by comparing journal vs DB count.
  const journal = await import('node:fs').then((fs) =>
    fs.readFileSync('drizzle/migrations/meta/_journal.json', 'utf8'),
  );
  const j = JSON.parse(journal);
  console.log('journal entries:', j.entries.length);
  console.log('latest journal tag:', j.entries[j.entries.length - 1].tag);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
