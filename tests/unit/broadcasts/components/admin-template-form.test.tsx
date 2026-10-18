/**
 * `<AdminTemplateForm>` on AURA (spec 122 US12a, T1204).
 *
 * The fields move to AURA's TextField / Select; what they send does not
 * change (FR-011): POST for a new template with its locale, the
 * required-field errors only after the first submit, and the same
 * success toast + redirect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}));
vi.mock('@/components/shell/tiptap-loader', () => ({
  loadTiptapEditor: () =>
    function EditorStub({ onChange }: { onChange: (html: string) => void }) {
      return (
        <textarea aria-label="Body (HTML)" onChange={(e) => onChange(e.target.value)} />
      );
    },
}));

import { AdminTemplateForm } from '@/components/broadcast/admin/template-form';

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
      <AdminTemplateForm mode="new" initial={{ name: '', subject: '', bodyHtml: '', locale: 'en' }} />
    </NextIntlClientProvider>,
  );
}

describe('<AdminTemplateForm> on AURA', () => {
  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
    toastSuccess.mockReset();
  });

  it('renders the name, subject and locale as AURA fields', () => {
    renderForm();
    for (const name of [/^name$/i, /^subject$/i]) {
      expect(screen.getByRole('textbox', { name }).closest('.aura-input')).not.toBeNull();
    }
    expect(screen.getByRole('combobox', { name: /^locale$/i }).closest('.aura-input')).not.toBeNull();
  });

  it('shows the required errors only after the first submit', () => {
    const { container } = renderForm();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    fireEvent.submit(container.querySelector('form')!);
    expect(screen.getAllByText(enMessages.admin.broadcasts.templates.errors.field_required).length).toBe(3);
    expect(screen.getByRole('textbox', { name: /^name$/i })).toHaveAttribute('aria-invalid', 'true');
  });

  it('POSTs a new template with its locale, then toasts and returns to the list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useRealTimers();
    try {
      renderForm();
      fireEvent.change(screen.getByRole('textbox', { name: /^name$/i }), { target: { value: 'Seminar' } });
      fireEvent.change(screen.getByRole('textbox', { name: /^subject$/i }), { target: { value: 'Hello' } });
      fireEvent.change(screen.getByRole('textbox', { name: 'Body (HTML)' }), { target: { value: '<p>x</p>' } });
      fireEvent.click(screen.getByRole('button', { name: /save template/i }));
      await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/broadcasts/templates'));
      expect(fetchMock).toHaveBeenCalledWith('/api/admin/broadcasts/templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Seminar', subject: 'Hello', bodyHtml: '<p>x</p>', locale: 'en' }),
      });
      expect(toastSuccess).toHaveBeenCalledWith(enMessages.admin.broadcasts.templates.savedToast);
      expect(refresh).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.useFakeTimers({ now: new Date('2026-04-09T12:00:00.000Z'), shouldAdvanceTime: false, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    }
  });
});
