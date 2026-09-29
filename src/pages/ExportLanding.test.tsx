/**
 * Rules table H3 (AJ Conner, 2026-09-20): the recipient page shows the
 * sender's name AND email. The page used to show the name, falling back to the
 * address only when there was no name, so the address was never seen.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SenderLine } from './ExportLanding';

describe('SenderLine', () => {
  it('shows the name and the address, the address as a mailto link', () => {
    render(<SenderLine name="Chris Cush" email="chris@example.com" />);
    expect(screen.getByText(/Chris Cush/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'chris@example.com' });
    expect(link).toHaveAttribute('href', 'mailto:chris@example.com');
  });

  it('shows the address alone when there is no name', () => {
    render(<SenderLine name={null} email="qa@example.com" />);
    expect(screen.getByRole('link', { name: 'qa@example.com' })).toBeInTheDocument();
  });

  it('never invents an address', () => {
    const { container } = render(<SenderLine name="Chris Cush" email={null} />);
    expect(container.textContent).toBe('Chris Cush');
    expect(screen.queryByRole('link')).toBeNull();
  });
});
