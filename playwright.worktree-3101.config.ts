/**
 * TEMPORARY, NOT COMMITTED — worktree-local override so this worktree's
 * e2e run hits its OWN dev server on :3101 instead of the shared :3100
 * server the user runs from the main checkout. Delete after use.
 */
import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

export default defineConfig({
  ...baseConfig,
  use: {
    ...baseConfig.use,
    baseURL: 'http://localhost:3101',
  },
  webServer: {
    ...baseConfig.webServer,
    command: 'pnpm dev --port 3101',
    url: 'http://localhost:3101',
    reuseExistingServer: false,
  },
});
