/**
 * Harness positive control: `sweepLeftoverTestUsers` removes the test users a
 * file created but never deleted. Without it, every suite that skips
 * `deleteTestUser` leaves an ACTIVE admin on the shared dev branch, and each
 * one is another row in every per-reviewer outbox fan-out (1,327 leaked
 * 2026-10-20..24; a change-request submit took 60–83 s). Lives in `auth/` so
 * the nightly rotation sweeps it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { createActiveTestUser, deleteTestUser, sweepLeftoverTestUsers } from '../helpers/test-users';

const statusOf = async (id: string) =>
  (await db.select({ status: users.status }).from(users).where(eq(users.id, id)))[0]?.status ?? 'deleted';

describe('integration harness: leftover test users are swept', () => {
  it('removes a user the file created and never deleted', async () => {
    const leaked = await createActiveTestUser();
    expect(await statusOf(leaked.userId)).toBe('active');
    const swept = await sweepLeftoverTestUsers();
    expect(swept).toBe(1);
    expect(await statusOf(leaked.userId)).toBe('deleted');
  });

  it('leaves nothing to sweep once the file deleted its own users', async () => {
    const user = await createActiveTestUser();
    await deleteTestUser(user);
    expect(await sweepLeftoverTestUsers()).toBe(0);
  });

  // The function above only matters if something calls it: the setup file's
  // afterAll must read the SAME registry key and call the sweep.
  it('the setup file sweeps in afterAll through the shared registry key', () => {
    const setup = readFileSync(resolve(process.cwd(), 'tests/integration-setup.ts'), 'utf8');
    expect(setup).toMatch(/import \{ LIVE_TEST_USERS_KEY \} from '\.\/integration\/helpers\/live-test-users-key'/);
    expect(setup).toMatch(/afterAll\(async \(\) => \{[\s\S]*?\[LIVE_TEST_USERS_KEY\][\s\S]*?sweepLeftoverTestUsers\(\)/);
  });
});
