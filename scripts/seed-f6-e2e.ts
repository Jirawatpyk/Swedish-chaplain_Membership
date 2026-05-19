/**
 * Run F6 E2E seed directly — smoke check that the seed SQL succeeds
 * against live Neon. Not part of the test pipeline.
 *
 *   pnpm tsx scripts/seed-f6-e2e.ts
 */
process.loadEnvFile?.('.env.local');

import { seedF6Events } from '../tests/e2e/helpers/eventcreate-seed';

void seedF6Events()
  .then((r) => {
    console.log('seed result:', JSON.stringify(r, null, 2));
    process.exit(0);
  })
  .catch((e) => {
    console.error('seed failed:', e);
    process.exit(1);
  });
