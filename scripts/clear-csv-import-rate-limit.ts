/**
 * Dev/incident utility — clear the F6.1 CSV-import rate-limit key for a
 * specific (tenant, actor) pair in Upstash. Used to unblock testing /
 * debugging when 5/hr cap is hit.
 *
 * Usage:
 *   pnpm tsx scripts/clear-csv-import-rate-limit.ts                 # default: swecham + the actor seen in recent logs
 *   pnpm tsx scripts/clear-csv-import-rate-limit.ts <tenant> <user> # explicit
 */
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]?.replace(/^"|"$/g, '');
}
import { Redis } from '@upstash/redis';

const TENANT_ID = process.argv[2] ?? 'swecham';
const ACTOR_USER_ID =
  process.argv[3] ?? '0f2ded5d-60bf-4208-a41b-5f1e6efbf7ba';

async function main() {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      'Upstash creds missing — set KV_REST_API_URL + KV_REST_API_TOKEN OR UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN',
    );
  }
  const redis = new Redis({ url, token });

  // Upstash @upstash/ratelimit sliding-window stores keys under the
  // identifier passed to limit() prefixed by its own namespace. The
  // identifier used in events-csv-import-deps.ts is
  // `f6-csv-import:{tenant}:{actor}`. We delete every key that contains
  // this identifier — Upstash ratelimit uses suffixes like ":counter"
  // and timestamp shards.
  const identifier = `f6-csv-import:${TENANT_ID}:${ACTOR_USER_ID}`;
  console.log(`\n=== Clearing rate-limit for identifier: ${identifier} ===\n`);

  // SCAN all matching keys.
  let cursor = '0';
  const matched: string[] = [];
  do {
    const [next, batch] = await redis.scan(cursor, {
      match: `*${identifier}*`,
      count: 500,
    });
    cursor = next as string;
    matched.push(...(batch as string[]));
  } while (cursor !== '0');

  if (matched.length === 0) {
    console.log('No matching keys found — rate limit may have already expired.');
    return;
  }

  console.log(`Matched ${matched.length} keys:`);
  for (const k of matched) console.log(' ', k);

  const deleted = await redis.del(...matched);
  console.log(`\n✓ Deleted ${deleted} key(s). Rate limit cleared.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
