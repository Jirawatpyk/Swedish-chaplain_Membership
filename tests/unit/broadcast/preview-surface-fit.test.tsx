/**
 * Spec 122 US12c-1 (parity, maintainer 20 Oct, thread "ช่องว่างอะไรครับ ตรงนี้")
 * — on the read-only staff detail a preview frame is as tall as the e-mail
 * (`fit`), as the boards draw it, instead of a fixed 560px box with empty
 * space under a short e-mail. To read the document's height the frame is
 * `sandbox="allow-same-origin"` — still no scripts, forms, popups or top
 * navigation. Without `fit` (compose pane, dialog, portal) it stays the empty
 * allow-list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { PreviewSurface, type PreviewState } from '@/components/broadcast/use-preview-html';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const READY: PreviewState = { status: 'ready', html: '<!doctype html><html><body><p>Hi</p></body></html>' };

function surface(state: PreviewState, fit?: boolean) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PreviewSurface state={state} height={560} {...(fit ? { fit } : {})} />
    </NextIntlClientProvider>
  );
}

function renderSurface(fit?: boolean) {
  const { container } = render(surface(READY, fit));
  return container.querySelector('iframe')!;
}

function stubObserver() {
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = observe;
      disconnect = disconnect;
    },
  );
  return { observe, disconnect };
}

/** Give the frame a document whose body is `height` px tall, then fire its load. */
function loadWithBody(frame: HTMLIFrameElement, height: number) {
  const body = document.createElement('body');
  body.getBoundingClientRect = () => ({ height }) as DOMRect;
  Object.defineProperty(frame, 'contentDocument', { configurable: true, value: { body } });
  fireEvent.load(frame);
}

describe('PreviewSurface fit', () => {
  it('without fit: the empty sandbox and the fixed height, unchanged', () => {
    const frame = renderSurface();
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.style.height).toBe('560px');
  });

  it('with fit: same-origin only (no scripts, forms, popups or navigation) and the frame takes the e-mail height', () => {
    const { observe } = stubObserver();
    const frame = renderSurface(true);
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(frame.getAttribute('srcdoc')).toBe(READY.status === 'ready' ? READY.html : '');
    expect(frame.hasAttribute('src')).toBe(false);
    expect(frame.style.height).toBe('560px');
    loadWithBody(frame, 412.4);
    expect(frame.style.height).toBe('413px');
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('with fit: measures a document that loaded before hydration (no load event left to catch)', () => {
    const { observe } = stubObserver();
    const body = document.createElement('body');
    body.getBoundingClientRect = () => ({ height: 300 }) as DOMRect;
    vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockReturnValue({
      readyState: 'complete',
      URL: 'about:srcdoc',
      body,
    } as unknown as Document);
    const frame = renderSurface(true);
    expect(frame.style.height).toBe('300px');
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('with fit: ignores the initial about:blank document', () => {
    stubObserver();
    const body = document.createElement('body');
    body.getBoundingClientRect = () => ({ height: 10 }) as DOMRect;
    vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockReturnValue({
      readyState: 'complete',
      URL: 'about:blank',
      body,
    } as unknown as Document);
    expect(renderSurface(true).style.height).toBe('560px');
  });

  it('with fit: stops watching when the frame goes away', () => {
    const { disconnect } = stubObserver();
    const { container, rerender } = render(surface(READY, true));
    loadWithBody(container.querySelector('iframe')!, 200);
    act(() => rerender(surface({ status: 'loading' }, true)));
    expect(disconnect).toHaveBeenCalled();
  });

  it('with fit: keeps the reserved height when the document cannot be read', () => {
    const frame = renderSurface(true);
    Object.defineProperty(frame, 'contentDocument', { configurable: true, value: null });
    fireEvent.load(frame);
    expect(frame.style.height).toBe('560px');
  });
});
