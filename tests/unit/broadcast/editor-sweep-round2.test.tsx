/**
 * Spec 122 US12d-2, round 2 (the maintainer: "fix the old problems too") —
 * the rest of the whole-file sweep of the E-Blast editor:
 *
 *  #4  While an image uploads, Image and Banner stay usable, so a second
 *      upload or a banner started mid-flight attached the wrong description.
 *  #5  Upload first, then cancel the description: "Image uploaded." showed
 *      but nothing was inserted. Success is said at the insert; a cancel
 *      says the image was not added.
 *  #10 The hidden file input was an invisible tab stop.
 *  #12 The loading skeleton announced nothing reliably (label only) and was
 *      40px tall where the phone toolbar is three rows.
 *  #13 An empty editor showed no placeholder.
 *  #14 The live region's 1.5 s clear was never reset (a second toggle was
 *      cut short), and headings and quotes were not announced at all.
 *  #15 A refused upload's message stayed after the author started again,
 *      and was announced twice (inline alert + toast).
 *  #17 The (dormant) ClamAV probe called an offline browser "scanner down",
 *      polled hidden tabs, and could hang.
 *  #20 Hard-coded ids collide when two editors share a page.
 */
import { useImperativeHandle } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { toast } from '@/lib/toast';

const uploaderMocks = vi.hoisted(() => ({
  real: { current: true },
  props: { current: null as null | {
    readonly onUploaded: (blobUrl: string, imageId?: string) => void;
    readonly onUploadingChange?: (busy: boolean) => void;
  } },
}));

vi.mock('@/lib/toast', () => ({
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/components/broadcast/compose-inline-image-uploader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/broadcast/compose-inline-image-uploader')>();
  return {
    ...actual,
    ComposeInlineImageUploader: (props: React.ComponentProps<typeof actual.ComposeInlineImageUploader>) => {
      if (uploaderMocks.real.current) return <actual.ComposeInlineImageUploader {...props} />;
      uploaderMocks.props.current = props;
      // eslint-disable-next-line react-hooks/rules-of-hooks -- a stub rendered on one branch per test
      useImperativeHandle(props.ref, () => ({ openPicker: () => {} }), []);
      return <span data-testid="uploader-stub" />;
    },
  };
});

const { default: TiptapEditor } = await import('@/components/broadcast/tiptap-editor');
const { ComposeInlineImageUploader } = await import('@/components/broadcast/compose-inline-image-uploader');
const { ClamavUnreachableBanner } = await import('@/components/broadcast/clamav-unreachable-banner');
const { loadTiptapEditor } = await import('@/components/shell/tiptap-loader');

const copy = enMessages.portal.broadcasts.compose.imageUpload;
const DRAFT = '11111111-1111-1111-1111-111111111111';

beforeAll(() => {
  const zero = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
  const rects = Object.assign([zero], { item: () => zero }) as unknown as DOMRectList;
  if (typeof Range.prototype.getClientRects !== 'function') Range.prototype.getClientRects = () => rects;
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = () => zero as DOMRect;
  }
});

beforeEach(() => {
  vi.useRealTimers();
  uploaderMocks.real.current = true;
  uploaderMocks.props.current = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const wrap = (node: React.ReactNode): React.ReactElement => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    {node}
  </NextIntlClientProvider>
);

async function renderEditor(html = '<p>hello</p>'): Promise<HTMLElement> {
  const { container } = render(
    wrap(<TiptapEditor initialHtml={html} onChange={() => {}} imagesEnabled draftId={DRAFT} />),
  );
  await screen.findByRole('toolbar');
  return container;
}

const control = (name: string): HTMLElement =>
  within(screen.getByRole('toolbar')).getByRole('button', { name });

describe('#4/#5 — the upload flow', () => {
  it('Image and Banner are unavailable while an upload runs', async () => {
    uploaderMocks.real.current = false;
    await renderEditor();
    act(() => uploaderMocks.props.current?.onUploadingChange?.(true));
    expect(control('Image')).toHaveAttribute('aria-disabled', 'true');
    expect(control('Banner image')).toHaveAttribute('aria-disabled', 'true');
    act(() => uploaderMocks.props.current?.onUploadingChange?.(false));
    expect(control('Image')).not.toHaveAttribute('aria-disabled');
  });

  it('says "not added" when the description is cancelled after an upload, and "uploaded" only at the insert', async () => {
    uploaderMocks.real.current = false;
    const container = await renderEditor();
    act(() => uploaderMocks.props.current?.onUploaded('https://assets.swecham.example/a.png'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^cancel$/i }));
    // No image id came back, so nothing is released: the toast promises nothing (spec 131).
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(copy.notInsertedKept));
    expect(toast.success).not.toHaveBeenCalled();

    act(() => uploaderMocks.props.current?.onUploaded('https://assets.swecham.example/b.png'));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/image description/i), { target: { value: 'The 2026 gala' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Insert image' }));
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(1));
    expect(toast.success).toHaveBeenCalledWith(copy.uploadedToast);
  });
});

describe('#10/#15/#20 — the uploader', () => {
  function renderUploaders(count: number): HTMLElement {
    const { container } = render(
      wrap(
        <>
          {Array.from({ length: count }, (_, i) => (
            <ComposeInlineImageUploader key={i} draftId={DRAFT} onUploaded={() => {}} />
          ))}
        </>,
      ),
    );
    return container;
  }

  it('the hidden input is not a tab stop, and two uploaders do not share ids', () => {
    const container = renderUploaders(2);
    const inputs = [...container.querySelectorAll('input[type="file"]')];
    expect(inputs[0]).toHaveAttribute('tabindex', '-1');
    expect(inputs[0]!.id).not.toBe(inputs[1]!.id);
    const described = inputs.map((i) => i.getAttribute('aria-describedby'));
    expect(described[0]).not.toBe(described[1]);
  });

  it('a refused upload is said once (the toast), and its message clears when the author starts again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'unknown' }), { status: 500 })),
    );
    const container = renderUploaders(1);
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText(copy.errors.unknown)).toBeInTheDocument());
    expect(toast.error).toHaveBeenCalledWith(copy.errors.unknown);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.uploadButton }));
    expect(screen.queryByText(copy.errors.unknown)).toBeNull();
  });
});

describe('#13/#14 — placeholder and announcements', () => {
  it('an empty editor carries its placeholder', async () => {
    const container = await renderEditor('');
    const area = container.querySelector('.ProseMirror') as HTMLElement;
    expect(area).toHaveAttribute('aria-placeholder', enMessages.broadcast.editor.placeholder);
    expect(area.style.getPropertyValue('--eblast-placeholder')).toBe(
      JSON.stringify(enMessages.broadcast.editor.placeholder),
    );
  });

  it('announces headings, and a quick second toggle is not cut short', async () => {
    const container = await renderEditor();
    const live = within(container).getByTestId('tiptap-aria-live');
    fireEvent.click(control('Heading'));
    // Set on the next frame, so a repeated message is announced again (round 3).
    await waitFor(() =>
      expect(live).toHaveTextContent(enMessages.portal.broadcasts.compose.editor.announcements.heading2On),
    );
    fireEvent.click(control('Bold'));
    await new Promise((r) => setTimeout(r, 1000));
    fireEvent.click(control('Bold'));
    await waitFor(() => expect(live).toHaveTextContent('Bold off'));
    await new Promise((r) => setTimeout(r, 700));
    expect(live).toHaveTextContent('Bold off');
  }, 10_000);
});

describe('#12 — the loading skeleton', () => {
  it('says it is loading in text and reserves the phone toolbar height', () => {
    const Loading = loadTiptapEditor<Record<string, never>>(
      () => new Promise<{ default: React.ComponentType<Record<string, never>> }>(() => {}),
    );
    render(wrap(<Loading />));
    const status = screen.getByTestId('tiptap-loading');
    expect(within(status).getByText(enMessages.shell.editorLoading)).toHaveClass('sr-only');
    expect(status.querySelector('[data-slot="skeleton-block"]')).toHaveClass('h-[152px]', 'sm:h-[104px]');
  });
});

describe('#17 — the ClamAV probe', () => {
  it('does not probe, nor claim the scanner is down, while the browser is offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(wrap(<ClamavUnreachableBanner healthEndpoint="/api/test/clamav" />));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(enMessages.portal.broadcasts.compose.clamavBanner.title)).toBeNull();
  });

  it('does not probe a hidden tab', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(wrap(<ClamavUnreachableBanner healthEndpoint="/api/test/clamav" />));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('gives each probe a timeout', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    render(wrap(<ClamavUnreachableBanner healthEndpoint="/api/test/clamav" />));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('#19 — the copy says what happens', () => {
  it('the upload hint says images are scanned before they are stored, not before upload', () => {
    expect(copy.helpText).toContain("before they're stored");
    expect(enMessages.portal.broadcasts.compose.editor.announcements.bulletListOn).toBe('Bulleted list on');
  });
});

// Spec 131 (layer 1) — the cancelled upload is RELEASED: the editor asks the
// endpoint beside the upload route to stamp the row for the next daily sweep,
// and says so only once it succeeded; otherwise the toast is `notInsertedKept`.
describe('spec 131 — a cancelled upload is released', () => {
  const IMAGE_ID = '55555555-5555-5555-5555-555555555555';
  const OTHER_DRAFT = '66666666-6666-6666-6666-666666666666';
  const NOT_INSERTED = enMessages.portal.broadcasts.compose.imageUpload.notInserted;

  function okFetch() {
    const spy = vi.fn(async () => new Response(JSON.stringify({ released: true }), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  function renderHost(props: { imageUploadUrl?: string; draftId?: string } = {}) {
    uploaderMocks.real.current = false;
    const { draftId = DRAFT, ...rest } = props;
    return render(wrap(<TiptapEditor initialHtml="<p>hello</p>" onChange={() => {}} imagesEnabled draftId={draftId} {...rest} />));
  }

  async function uploadThenCancel(props: { imageUploadUrl?: string } = {}): Promise<void> {
    renderHost(props);
    await screen.findByRole('toolbar');
    act(() => uploaderMocks.props.current?.onUploaded('https://assets.swecham.example/a.png', IMAGE_ID));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^cancel$/i }));
  }

  it('the copy names no destination and does not promise a hard deadline (#658 UX / PDPA)', () => {
    expect(NOT_INSERTED).toBe("The image wasn't added. It will be removed automatically, usually within a day.");
  });

  it('member host: DELETE /api/broadcasts/inline-image-upload/<imageId>?draftId=<draft>, and the toast says so', async () => {
    const fetchSpy = okFetch();
    await uploadThenCancel();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/broadcasts/inline-image-upload/${IMAGE_ID}?draftId=${DRAFT}`);
    expect(init.method).toBe('DELETE');
    expect(toast.info).toHaveBeenCalledWith(NOT_INSERTED);
  });

  it('staff and template hosts: the release goes beside the host\'s own upload URL', async () => {
    const fetchSpy = okFetch();
    await uploadThenCancel({ imageUploadUrl: `/api/admin/broadcasts/templates/${DRAFT}/images` });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect((fetchSpy.mock.calls[0] as unknown as [string])[0]).toBe(
      `/api/admin/broadcasts/templates/${DRAFT}/images/${IMAGE_ID}?draftId=${DRAFT}`,
    );
  });

  it('confirming the description inserts the image and releases nothing', async () => {
    const fetchSpy = okFetch();
    const { container } = renderHost();
    await screen.findByRole('toolbar');
    act(() => uploaderMocks.props.current?.onUploaded('https://assets.swecham.example/a.png', IMAGE_ID));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/image description/i), { target: { value: 'The 2026 gala' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Insert image' }));
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the release names the draft the image was uploaded to, even if the host\'s draft changed since', async () => {
    const fetchSpy = okFetch();
    const view = renderHost();
    await screen.findByRole('toolbar');
    act(() => uploaderMocks.props.current?.onUploaded('https://assets.swecham.example/a.png', IMAGE_ID));
    view.rerender(wrap(<TiptapEditor initialHtml="<p>hello</p>" onChange={() => {}} imagesEnabled draftId={OTHER_DRAFT} />));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect((fetchSpy.mock.calls[0] as unknown as [string])[0]).toBe(
      `/api/broadcasts/inline-image-upload/${IMAGE_ID}?draftId=${DRAFT}`,
    );
  });

  it('leaving the page with the description still open releases the upload', async () => {
    const fetchSpy = okFetch();
    const view = renderHost();
    await screen.findByRole('toolbar');
    act(() => uploaderMocks.props.current?.onUploaded('https://assets.swecham.example/a.png', IMAGE_ID));
    view.unmount();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].keepalive).toBe(true);
  });

  it('a failed release promises nothing: the toast only says it was not added (#658 code review)', async () => {
    const fetchSpy = vi.fn(async () => { throw new TypeError('offline'); });
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await uploadThenCancel();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
    expect(toast.info).toHaveBeenCalledWith(enMessages.portal.broadcasts.compose.imageUpload.notInsertedKept);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a refused release (e.g. 429) promises nothing either', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await uploadThenCancel();

    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
    expect(toast.info).toHaveBeenCalledWith(enMessages.portal.broadcasts.compose.imageUpload.notInsertedKept);
  });
});
