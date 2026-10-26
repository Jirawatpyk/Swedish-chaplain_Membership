/**
 * Spec 122 US12d-2 (mobile-a11y review, fixed at the user's word, 25 Oct):
 * between the editor chunk arriving and Tiptap creating its editor, the
 * editor drew a static grey box. It now shows the same pulse skeleton the
 * loader shows while the chunk loads (`TiptapLoadingSkeleton`, AURA pulse via
 * `skeleton-shimmer`, ux-standards § 2.1), so loading reads as one state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('@tiptap/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tiptap/react')>()),
  useEditor: () => null,
}));

const { default: TiptapEditor } = await import('@/components/broadcast/tiptap-editor');

afterEach(() => {
  cleanup();
});

describe('the editor before Tiptap is ready', () => {
  it('shows the pulse loading skeleton, announced as loading', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TiptapEditor initialHtml="" onChange={() => {}} />
      </NextIntlClientProvider>,
    );
    const status = screen.getByTestId('tiptap-loading');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAccessibleName(enMessages.shell.editorLoading);
    expect(status.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(0);
  });
});
