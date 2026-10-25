/**
 * The globalThis key of the live-test-user registry (`test-users.ts`). Its own
 * module, with no imports, so `tests/integration-setup.ts` can read the
 * registry without importing the db into every test file.
 */
export const LIVE_TEST_USERS_KEY = Symbol.for('chamber-os.integration.liveTestUsers');
