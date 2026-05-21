import { Redis } from '@upstash/redis';
import { readFileSync } from 'node:fs';

const text = readFileSync('.env.local', 'utf8');
const env: Record<string, string> = {};
for (const line of text.split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
}

const redis = new Redis({
  url: env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL ?? '',
  token: env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN ?? '',
});

async function main(): Promise<void> {
  let cursor = '0';
  const keys: string[] = [];
  do {
    const [next, batch] = (await redis.scan(cursor, {
      match: '*',
      count: 500,
    })) as [string, string[]];
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  console.log('Total keys:', keys.length);
  for (const k of keys.slice(0, 50)) console.log(' -', k);

  // Clear ALL sign-in related keys (broad pattern)
  const targets = keys.filter(
    (k) =>
      k.startsWith('swecham') ||
      k.includes('signin') ||
      k.includes('sign-in') ||
      k.includes('e2e-'),
  );
  if (targets.length > 0) {
    console.log(`\nDeleting ${targets.length} sign-in/e2e-related keys…`);
    await redis.del(...targets);
    console.log('Done.');
  } else {
    console.log('\nNo sign-in-related keys to delete.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
