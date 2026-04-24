import { readFileSync } from 'node:fs';
import postgres from 'postgres';
async function main() {
  const path = process.argv[2];
  if (!path) { console.error('Usage: dev-apply-migration.ts <path>'); process.exit(1); }
  const sql = readFileSync(path, 'utf8');
  const c = postgres(process.env.DATABASE_URL!, { max: 1 });
  await c.unsafe(sql);
  console.log('applied', path);
  await c.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
