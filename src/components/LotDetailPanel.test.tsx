import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LotBadges } from './LotDetailPanel';

describe('LotBadges', () => {
  it('renders COA and orders counts', () => {
    render(<LotBadges coaCount={3} matchedOrderCount={2} suggestedCount={0} />);
    expect(screen.getByText('3 COA')).toBeInTheDocument();
    expect(screen.getByText('2 orders')).toBeInTheDocument();
  });

  it('shows the suggested chip only when there are pending suggestions', () => {
    const { rerender } = render(
      <LotBadges coaCount={0} matchedOrderCount={0} suggestedCount={0} />,
    );
    expect(screen.queryByText(/suggested/)).not.toBeInTheDocument();

    rerender(<LotBadges coaCount={0} matchedOrderCount={0} suggestedCount={5} />);
    expect(screen.getByText('5 suggested')).toBeInTheDocument();
  });
});
