import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TableContainer } from '@/components/layout/table-container';

describe('<TableContainer>', () => {
  it('renders children', () => {
    render(
      <TableContainer>
        <p>hello</p>
      </TableContainer>,
    );
    expect(screen.getByText('hello')).toBeDefined();
  });

  it('sets data-slot="layout-container" and data-variant="table"', () => {
    const { container } = render(
      <TableContainer>
        <p>body</p>
      </TableContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute('data-slot')).toBe('layout-container');
    expect(wrapper.getAttribute('data-variant')).toBe('table');
  });

  it('applies the 96rem max-width token (--layout-max-width-table)', () => {
    const { container } = render(
      <TableContainer>
        <p>body</p>
      </TableContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toMatch(/layout-max-width-table/);
  });

  it('merges custom className', () => {
    const { container } = render(
      <TableContainer className="custom-class">
        <p>body</p>
      </TableContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toMatch(/custom-class/);
  });

  it('does NOT own horizontal scroll (overflow-x must remain visible — FR-015)', () => {
    const { container } = render(
      <TableContainer>
        <p>body</p>
      </TableContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).not.toMatch(/overflow-x-(?:auto|scroll|hidden)/);
    expect(wrapper.className).not.toMatch(/overflow-(?:auto|scroll|hidden)/);
  });

  // Round-8 R8 review fix (2026-05-13, closes S-3 gap): see
  // detail-container.test.tsx for full rationale.
  it('forwards aria-busy="true" prop to the underlying div', () => {
    const { container } = render(
      <TableContainer aria-busy="true">
        <p>body</p>
      </TableContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute('aria-busy')).toBe('true');
  });

  it('omits aria-busy when prop not provided', () => {
    const { container } = render(
      <TableContainer>
        <p>body</p>
      </TableContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute('aria-busy')).toBeNull();
  });
});
