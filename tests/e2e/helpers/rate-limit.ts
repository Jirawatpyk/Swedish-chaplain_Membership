/**
 * E2E helper: wipe all Upstash rate-limit buckets that start with
 * the `swecham` prefix.
 *
 * Used from `beforeAll` hooks in specs that sign in multiple times
 * per run, so the 5/15-min per-email bucket doesn't trip when the
 * same test admin account is reused across many specs.
 *
 * NOTE: this talks directly to Upstash via the env vars loaded from
 * `.env.local` by Playwright. We import `@upstash/redis` at runtime
 * (not via the project's adapter) to avoid pulling the full
 * application-layer dependency graph into the Playwright worker.
 */
import { Redis } from '@upstash/redis';

export async function clearE2ERateLimits(): Promise<void> {
  // Vercel KV integration exports KV_REST_API_{URL,TOKEN}; plain
  // Upstash exports UPSTASH_REDIS_REST_{URL,TOKEN}. Support either.
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    // Missing env vars → no-op. The run will still work, it just
    // won't defend against cross-spec rate-limit pollution.
    return;
  }
  const redis = new Redis({ url, token });
  let cursor = '0';
  const matches: string[] = [];
  do {
    const [next, keys] = (await redis.scan(cursor, {
      match: 'swecham*',
      count: 200,
    })) as [string, string[]];
    cursor = next;
    matches.push(...keys);
  } while (cursor !== '0');
  if (matches.length > 0) {
    await redis.del(...matches);
  }
}
