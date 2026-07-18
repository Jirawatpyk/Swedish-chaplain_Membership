import { renderHook } from '@testing-library/react';
import { useUnsavedGuard } from '@/components/invoices/invoice-settings/use-unsaved-guard';

it('adds a beforeunload listener when dirty and removes it when clean', () => {
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  const { rerender, unmount } = renderHook(({ d }) => useUnsavedGuard(d), { initialProps: { d: true } });
  expect(add).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  rerender({ d: false });
  expect(remove).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  unmount();
});
