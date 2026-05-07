import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ResultCardBundle } from './ResultCardBundle';

const wrap = (ui: React.ReactNode) => <MemoryRouter>{ui}</MemoryRouter>;

describe('ResultCardBundle', () => {
  it('renders the bundle name with mark highlighting', () => {
    render(
      wrap(
        <ResultCardBundle
          bundle={{ id: 'b_1', name: '<mark>Q4</mark> Compliance Pack' }}
        />,
      ),
    );
    expect(screen.getByText('Q4').tagName.toLowerCase()).toBe('mark');
  });
});
