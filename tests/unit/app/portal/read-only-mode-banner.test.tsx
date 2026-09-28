// @vitest-environment jsdom
/**
 * Portal error states follow-up — the read-only banner on page load.
 *
 * During a READ_ONLY_MODE freeze a member only learned about it when a submit
 * was refused (#388, #390). The banner says so on every portal page first. It
 * is advisory: the per-form 503 handling stays the source of truth, since a
 * tab opened before the freeze sees the banner only after a reload.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import enMessages from '@/i18n/messages/en.json';

type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined),
      obj,
    );
}

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) => (key: string): string => {
    const val = getPath(getPath(enMessages as unknown, ns), key);
    return typeof val === 'string' ? val : `MISSING_KEY:${ns}.${key}`;
  }),
}));

const flags = vi.hoisted(() => ({ readOnlyMode: false }));
vi.mock('@/lib/env', () => ({ env: { flags } }));

import { ReadOnlyModeBanner } from '@/app/(member)/portal/_components/read-only-mode-banner';

afterEach(() => {
  cleanup();
  flags.readOnlyMode = false;
});

describe('ReadOnlyModeBanner', () => {
  it('while READ_ONLY_MODE is on, says so as a polite status with a way to read it', async () => {
    flags.readOnlyMode = true;
    const ui = await ReadOnlyModeBanner();
    render(<>{ui}</>);

    const banner = screen.getByTestId('read-only-mode-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent(enMessages.errors.readOnlyMode);
    expect(banner).toHaveTextContent(enMessages.errors.readOnlyModeBrowse);
    expect(document.body.textContent).not.toContain('MISSING_KEY');
  });

  it('renders nothing while the system is writable', async () => {
    expect(await ReadOnlyModeBanner()).toBeNull();
  });
});
