import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { keepTermTogether } from '@/components/broadcast/keep-term-together';

describe('keepTermTogether', () => {
  it('wraps every "E-Blast" in a nowrap span and keeps the text unchanged', () => {
    const { container } = render(<h1>{keepTermTogether('เขียน E-Blast · E-Blasts')}</h1>);
    expect(container.textContent).toBe('เขียน E-Blast · E-Blasts');
    const spans = container.querySelectorAll('span.whitespace-nowrap');
    expect(spans).toHaveLength(2);
    spans.forEach((s) => expect(s.textContent).toBe('E-Blast'));
  });

  it('returns text without the term as-is', () => {
    expect(keepTermTogether('Skapa utskick')).toBe('Skapa utskick');
  });
});
