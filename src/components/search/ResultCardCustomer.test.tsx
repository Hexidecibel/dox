import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ResultCardCustomer } from './ResultCardCustomer';

const wrap = (ui: React.ReactNode) => <MemoryRouter>{ui}</MemoryRouter>;

describe('ResultCardCustomer', () => {
  it('renders name and customer number', () => {
    render(
      wrap(
        <ResultCardCustomer
          customer={{ id: 'c_1', name: 'Sysco', customer_number: '12345' }}
        />,
      ),
    );
    expect(screen.getByText('Sysco')).toBeInTheDocument();
    expect(screen.getByText('#12345')).toBeInTheDocument();
  });

  it('renders without customer_number', () => {
    render(wrap(<ResultCardCustomer customer={{ id: 'c_1', name: 'Sysco' }} />));
    expect(screen.getByText('Sysco')).toBeInTheDocument();
    expect(screen.queryByText(/^#/)).not.toBeInTheDocument();
  });
});
