import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ResultCardOrder } from './ResultCardOrder';

const wrap = (ui: React.ReactNode) => <MemoryRouter>{ui}</MemoryRouter>;

describe('ResultCardOrder', () => {
  it('renders order_number, customer_name, and PO suffix', () => {
    render(
      wrap(
        <ResultCardOrder
          order={{
            id: 'o_1',
            order_number: 'SO-1234',
            po_number: 'PO-555',
            customer_name: 'Sysco',
          }}
        />,
      ),
    );
    expect(screen.getByText(/SO-1234/)).toBeInTheDocument();
    expect(screen.getByText(/PO-555/)).toBeInTheDocument();
    expect(screen.getByText(/Sysco/)).toBeInTheDocument();
  });

  it('falls back to id when order_number missing', () => {
    render(wrap(<ResultCardOrder order={{ id: 'o_1' }} />));
    expect(screen.getByText('o_1')).toBeInTheDocument();
  });
});
