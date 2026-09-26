/**
 * `@/lib/toast` — the product's single toast API (spec 122 FR-007,
 * contracts/toast-facade.md). Every call site and every test mock goes
 * through this module, so the library behind it can change in one place.
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
vi.mock('sonner', () => ({ toast: impl }));

import { toast } from '@/lib/toast';

describe('@/lib/toast facade', () => {
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
      const [title, opts] = impl[method]!.mock.calls[0] as [string, Record<string, unknown>];
      expect(title).toBe('Saved');
      expect(opts).toMatchObject({ description: 'The plan was updated.', id: 'plan-save', duration: 8000 });
      expect((opts.action as { label: string }).label).toBe('Undo');
    },
  );

  it('a plain call is the neutral toast and returns its id', () => {
    expect(toast('Sending in a moment')).toBe('id-plain');
    expect(impl).toHaveBeenCalledWith('Sending in a moment', undefined);
  });

  it('an action without onClick still reaches the library with a callable onClick', () => {
    toast.info('Heads up', { action: { label: 'OK' } });
    const opts = impl.info!.mock.calls[0]![1] as { action: { onClick: unknown } };
    expect(typeof opts.action.onClick).toBe('function');
  });

  it('returns ids as strings even when the library hands back a number', () => {
    impl.success!.mockReturnValueOnce(7 as unknown as string);
    expect(toast.success('Done')).toBe('7');
  });

  it('dismiss forwards the id', () => {
    toast.dismiss('plan-save');
    expect(impl.dismiss).toHaveBeenCalledWith('plan-save');
  });
});
