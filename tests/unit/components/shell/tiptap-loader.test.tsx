/**
 * `loadTiptapEditor` (spec 122 US12a, T1202) — the loader lives in the
 * shell and draws its loading state with the shared skeleton blocks, not
 * the legacy kit's `Skeleton`. The status role, label and test id stay.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ComponentType } from 'react';

vi.mock('next/dynamic', () => ({
  default: (_loader: unknown, opts: { loading: ComponentType }) => opts.loading,
}));

import { loadTiptapEditor } from '@/components/shell/tiptap-loader';

describe('loadTiptapEditor', () => {
  it('shows one labelled status with shared skeleton blocks while the editor loads', () => {
    const Editor = loadTiptapEditor(() => Promise.resolve({ default: () => null }));
    render(
      <NextIntlClientProvider locale="en" messages={{ shell: { editorLoading: 'Loading editor…' } }}>
        <Editor />
      </NextIntlClientProvider>,
    );
    const status = screen.getByRole('status', { name: 'Loading editor…' });
    expect(status).toHaveAttribute('data-testid', 'tiptap-loading');
    expect(status.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(2);
    expect(status.querySelector('[data-slot="skeleton"]')).toBeNull();
  });
});
