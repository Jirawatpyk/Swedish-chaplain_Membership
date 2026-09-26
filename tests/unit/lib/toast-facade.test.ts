/**
 * `@/lib/toast` — the product's single toast API (spec 122 FR-007,
 * contracts/toast-facade.md), backed by AURA's `toast`. Every call site and
 * every test mock goes through this module, so the library behind it changes
 * in one place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const impl = vi.hoisted(() => {
  const fn = vi.fn(() => 'id-plain') as ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>;
  fn.success = vi.fn(() => 'id-success');
  fn.error = vi.fn(() => 'id-error');
  fn.warning = vi.fn(() => 'id-warning');
  fn.info = vi.fn(() => 'id-info');
  fn.loading = vi.fn(() => 'id-loading');
  fn.dismiss = vi.fn();
  return fn;
});
vi.mock('@jirawatpyk/aura-react', () => ({ toast: impl }));

import { toast } from '@/lib/toast';

describe('@/lib/toast facade (AURA)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['success', 'error', 'warning', 'info', 'loading'] as const)(
    '%s forwards the title and the option subset, and returns the id',
    (method) => {
      const onClick = vi.fn();
      const id = toast[method]('Saved', {
        description: 'The plan was updated.',
        id: 'plan-save',
        duration: 8000,
        action: { label: 'Undo', onClick },
      });
      expect(id).toBe(`id-${method}`);
      expect(impl[method]).toHaveBeenCalledWith('Saved', {
        description: 'The plan was updated.',
        id: 'plan-save',
        duration: 8000,
        action: { label: 'Undo', onClick },
      });
    },
  );

  it('a plain call passes the title (and any options) as one AURA options object', () => {
    expect(toast('Sending in a moment')).toBe('id-plain');
    expect(impl).toHaveBeenCalledWith({ title: 'Sending in a moment' });
    toast('Queued', { id: 'q', duration: 3000 });
    expect(impl).toHaveBeenLastCalledWith({ title: 'Queued', id: 'q', duration: 3000 });
  });

  it('never forwards closeButton — every AURA toast is dismissible', () => {
    toast.warning('Check the bills', { closeButton: true, duration: Infinity });
    expect(impl.warning).toHaveBeenCalledWith('Check the bills', { duration: Infinity });
  });

  it('dismiss forwards the id', () => {
    toast.dismiss('plan-save');
    expect(impl.dismiss).toHaveBeenCalledWith('plan-save');
  });
});
