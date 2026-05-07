import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Snippet } from './Snippet';

describe('Snippet', () => {
  it('renders nothing for empty input', () => {
    const { container } = render(<Snippet text="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders <mark> elements for highlighted fragments', () => {
    render(<Snippet text="hello <mark>world</mark>!" />);
    const mark = screen.getByText('world');
    expect(mark.tagName.toLowerCase()).toBe('mark');
  });

  it('renders surrounding text as plain spans', () => {
    const { container } = render(<Snippet text="hello <mark>world</mark>!" />);
    // The container should contain the text "hello " and "!" as plain text.
    expect(container.textContent).toBe('hello world!');
  });

  it('does not honor stray HTML tags outside marks', () => {
    const { container } = render(
      <Snippet text="a <script>alert(1)</script> <mark>b</mark>" />,
    );
    // The stray <script> should be rendered as literal text, not a real
    // <script> element. Verify by querying for any script element.
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>');
  });

  it('handles multiple marks', () => {
    render(<Snippet text="<mark>foo</mark> and <mark>bar</mark>" />);
    expect(screen.getByText('foo').tagName.toLowerCase()).toBe('mark');
    expect(screen.getByText('bar').tagName.toLowerCase()).toBe('mark');
  });
});
