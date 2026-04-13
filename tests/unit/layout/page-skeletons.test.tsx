import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import {
  CardSkeleton,
  DetailSkeleton,
  FormSkeleton,
  PageSkeletonShell,
  SkeletonBlock,
  TableSkeleton,
} from '@/components/shell/page-skeletons';

/**
 * Block-count assertions use `toBeGreaterThanOrEqual` rather than an
 * exact `toBe(N)` so adding a visual spacer or decorative block in the
 * future doesn't break tests that aren't actually about count.
 */

describe('SkeletonBlock', () => {
  it('applies the skeleton-shimmer utility by default', () => {
    const { container } = render(<SkeletonBlock />);
    const el = container.querySelector('[data-slot="skeleton-block"]');
    expect(el).not.toBeNull();
    expect(el!.className).toContain('skeleton-shimmer');
  });

  it('merges caller className without dropping shimmer', () => {
    const { container } = render(<SkeletonBlock className="h-4 w-24" />);
    const el = container.querySelector('[data-slot="skeleton-block"]');
    expect(el!.className).toContain('skeleton-shimmer');
    expect(el!.className).toContain('h-4');
    expect(el!.className).toContain('w-24');
  });
});

describe('CardSkeleton', () => {
  it('emits aria-busy without claiming its own live region', () => {
    // The outer <PageSkeletonShell> is the sole role="status" region
    // per page; nested live regions cause some screen readers to
    // announce twice. CardSkeleton marks busy but doesn't set role.
    const { container } = render(<CardSkeleton />);
    const root = container.querySelector('[data-slot="card-skeleton"]');
    expect(root!.getAttribute('role')).toBeNull();
    expect(root!.getAttribute('aria-busy')).toBe('true');
  });

  it('renders at least as many blocks as rows + header', () => {
    const { container } = render(<CardSkeleton rows={5} />);
    const root = container.querySelector('[data-slot="card-skeleton"]');
    // header 2 (title + description) + 5 body rows = 7.
    expect(
      root!.querySelectorAll('[data-slot="skeleton-block"]').length,
    ).toBeGreaterThanOrEqual(7);
  });

  it('drops the description block when withDescription=false', () => {
    const withDesc = render(<CardSkeleton rows={3} withDescription />);
    const withoutDesc = render(<CardSkeleton rows={3} withDescription={false} />);
    const a = withDesc.container.querySelectorAll('[data-slot="skeleton-block"]').length;
    const b = withoutDesc.container.querySelectorAll('[data-slot="skeleton-block"]').length;
    expect(a - b).toBe(1);
  });
});

describe('FormSkeleton', () => {
  it('renders label + input pair per field plus the default single submit button', () => {
    const { container } = render(<FormSkeleton fields={3} />);
    const root = container.querySelector('[data-slot="form-skeleton"]');
    // title + description + 6 field blocks + 1 footer button = 9.
    expect(
      root!.querySelectorAll('[data-slot="skeleton-block"]').length,
    ).toBeGreaterThanOrEqual(9);
  });

  it('renders two footer buttons when footerButtons=2', () => {
    const { container } = render(<FormSkeleton fields={3} footerButtons={2} />);
    const root = container.querySelector('[data-slot="form-skeleton"]');
    expect(
      root!.querySelectorAll('[data-slot="skeleton-block"]').length,
    ).toBeGreaterThanOrEqual(10);
  });

  it('renders the LAST footer button wider (primary submit on the right)', () => {
    const { container } = render(
      <FormSkeleton fields={1} footerButtons={2} withHeader={false} />,
    );
    const root = container.querySelector('[data-slot="form-skeleton"]');
    const blocks = root!.querySelectorAll('[data-slot="skeleton-block"]');
    // Last 2 blocks are the footer buttons — confirm the tail one is wider.
    const secondToLast = blocks[blocks.length - 2]!.className;
    const last = blocks[blocks.length - 1]!.className;
    expect(secondToLast).toContain('w-20');
    expect(last).toContain('w-28');
  });

  it('omits footer buttons when footerButtons=0', () => {
    const withFooter = render(<FormSkeleton fields={2} footerButtons={1} />);
    const withoutFooter = render(<FormSkeleton fields={2} footerButtons={0} />);
    const diff =
      withFooter.container.querySelectorAll('[data-slot="skeleton-block"]').length -
      withoutFooter.container.querySelectorAll('[data-slot="skeleton-block"]').length;
    expect(diff).toBe(1);
  });

  it('drops the outer title/description + card chrome when withHeader=false', () => {
    const { container } = render(
      <FormSkeleton fields={3} footerButtons={1} withHeader={false} />,
    );
    const root = container.querySelector('[data-slot="form-skeleton"]');
    // 6 field blocks + 1 button = 7 at minimum. The class assertions
    // below verify the "no chrome" semantic directly; block count stays
    // soft for future decorative additions (see file header policy).
    expect(
      root!.querySelectorAll('[data-slot="skeleton-block"]').length,
    ).toBeGreaterThanOrEqual(7);
    expect(root!.className).not.toContain('border');
    expect(root!.className).not.toContain('bg-card');
  });

  it('declares itself as a loading status region', () => {
    const { container } = render(<FormSkeleton />);
    const root = container.querySelector('[data-slot="form-skeleton"]');
    expect(root!.getAttribute('aria-busy')).toBe('true');
  });
});

describe('TableSkeleton', () => {
  it('renders header + rows, each with `columns` cells', () => {
    const { container } = render(<TableSkeleton rows={3} columns={4} />);
    const root = container.querySelector('[data-slot="table-skeleton"]');
    // (header 4) + (rows 3 × cols 4) = 16 blocks minimum.
    expect(
      root!.querySelectorAll('[data-slot="skeleton-block"]').length,
    ).toBeGreaterThanOrEqual(16);
  });

  it('marks the skeleton as aria-busy but not role=status', () => {
    // See CardSkeleton's a11y test — PageSkeletonShell owns the live
    // region; nested primitives only carry aria-busy.
    const { container } = render(<TableSkeleton />);
    const root = container.querySelector('[data-slot="table-skeleton"]');
    expect(root!.getAttribute('role')).toBeNull();
    expect(root!.getAttribute('aria-busy')).toBe('true');
  });
});

describe('DetailSkeleton', () => {
  it('renders one label/value pair per item', () => {
    const { container } = render(<DetailSkeleton items={3} columns={2} />);
    const root = container.querySelector('[data-slot="detail-skeleton"]');
    // 3 items × 2 blocks per item = 6.
    expect(
      root!.querySelectorAll('[data-slot="skeleton-block"]').length,
    ).toBeGreaterThanOrEqual(6);
  });

  it('uses <dl> so description-list semantics survive', () => {
    const { container } = render(<DetailSkeleton items={1} />);
    const root = container.querySelector('[data-slot="detail-skeleton"]');
    expect(root!.tagName).toBe('DL');
  });
});

describe('PageSkeletonShell', () => {
  it('exposes aria-label and announces via aria-live', () => {
    const { getByText, container } = render(
      <PageSkeletonShell ariaLabel="Loading dashboard">
        <div>child</div>
      </PageSkeletonShell>,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute('aria-label')).toBe('Loading dashboard');
    expect(root.getAttribute('aria-live')).toBe('polite');
    expect(root.getAttribute('aria-busy')).toBe('true');
    expect(getByText('Loading dashboard')).toBeTruthy();
  });
});
