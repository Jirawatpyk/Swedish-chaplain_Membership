/**
 * Clear every `swecham:*` rate-limit key in Upstash.
 *
 * Used before E2E test runs so the bootstrap admin is not blocked by
 * the sliding window that the previous run consumed. Scans the whole
 * DB for keys under our prefix and deletes them in batches.
 *
 * Run via: `node --env-file=.env.local --import tsx scripts/clear-rate-limit.ts`
 * or the `pnpm db:clear-ratelimit` alias.
 *
 * Safe to run repeatedly. Only deletes keys under the `swecham:` prefix
 * so any other application sharing the same Upstash DB is untouched.
 */
process.loadEnvFile?.('.env.local');

import { Redis } from '@upstash/redis';

async function main(): Promise<void> {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error('clear-rate-limit: missing Upstash credentials');
    process.exit(1);
  }

  const redis = new Redis({ url, token });

  let cursor = '0';
  let totalDeleted = 0;
  const PATTERN = 'swecham*';

  do {
    const result = await redis.scan(cursor, { match: PATTERN, count: 200 });
    // @upstash/redis returns [nextCursor, keys]
    const [nextCursor, keys] = result as [string, string[]];
    cursor = nextCursor;

    if (keys.length > 0) {
      await redis.del(...keys);
      totalDeleted += keys.length;
    }
  } while (cursor !== '0');

  console.log(`cleared ${totalDeleted} rate-limit keys under prefix 'swecham'`);
}

main().catch((error) => {
  console.error('clear-rate-limit: crashed:', error);
  process.exit(1);
});
