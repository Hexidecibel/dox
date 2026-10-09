/**
 * The form builder's accent colour (migration 0140, decision C-116).
 *
 * The field used to be free text, stored as typed and drawn unchecked. It is
 * now a colour or nothing:
 *
 *   - `#abc` and lower case are NORMALISED on the way in, not refused;
 *   - anything else is refused with the reason and not saved;
 *   - a stored value that is not a colour is SAID to be unused, not silently
 *     ignored;
 *   - the outside `logo_url` no longer makes the round trip.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../lib/recordsApi', () => ({ recordsApi: {}, publicFormsApi: {} }));
vi.mock('../../lib/api', () => ({ api: {} }));

import { FormAccentField, settingsForSave } from './FormBuilder';

describe('FormAccentField', () => {
  it('commits a normalised colour on blur, not on every keystroke', async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(<FormAccentField stored={null} onCommit={onCommit} />);
    const input = screen.getByTestId('form-accent-input');
    await user.type(input, '#1a365d');
    // Typing passes through "#1a3", itself a colour: nothing is saved yet.
    expect(onCommit).not.toHaveBeenCalled();
    await user.tab();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('#1A365D');
    expect(input).toHaveValue('#1A365D');
  });

  it('a short hex is expanded rather than refused', async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(<FormAccentField stored={null} onCommit={onCommit} />);
    await user.type(screen.getByTestId('form-accent-input'), '#abc');
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith('#AABBCC');
    expect(screen.getByTestId('form-accent-input')).toHaveValue('#AABBCC');
  });

  it('anything that is not a hex colour is refused with the reason and NOT saved', async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(<FormAccentField stored="#1A365D" onCommit={onCommit} />);
    const input = screen.getByTestId('form-accent-input');
    for (const bad of ['red', '#12345', 'rgb(0,0,0)']) {
      await user.clear(input);
      await user.type(input, bad);
      await user.tab();
      expect(screen.getByText(/Accent colour must be a hex colour such as #1A365D/)).toBeInTheDocument();
    }
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('clearing the field clears the accent', async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(<FormAccentField stored="#1A365D" onCommit={onCommit} />);
    await user.clear(screen.getByTestId('form-accent-input'));
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('leaving the field unchanged saves nothing', async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(<FormAccentField stored="#1a365d" onCommit={onCommit} />);
    const input = screen.getByTestId('form-accent-input');
    expect(input).toHaveValue('#1A365D');
    await user.click(input);
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('form-accent-unused')).toBeNull();
  });

  it('a stored accent that is not a colour is SAID to be unused, and choosing one replaces it', async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(<FormAccentField stored="navy blue" onCommit={onCommit} />);
    const notice = screen.getByTestId('form-accent-unused');
    expect(notice.textContent).toContain('"navy blue"');
    expect(notice.textContent).toContain('is not a hex colour and is not being used');
    expect(notice.textContent).toContain("your organization's brand colour instead");
    expect(notice.textContent).toContain('cleared the next time this form is saved');
    // The field does not pretend the stored value is a colour.
    expect(screen.getByTestId('form-accent-input')).toHaveValue('');
    await user.type(screen.getByTestId('form-accent-input'), '#0b6e4f');
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith('#0B6E4F');
  });

  it('the picker is a real colour input', () => {
    render(<FormAccentField stored="#abc" onCommit={() => {}} />);
    const picker = screen.getByTestId('form-accent-picker');
    expect(picker).toHaveAttribute('type', 'color');
    expect(picker).toHaveValue('#aabbcc');
  });
});

describe('settingsForSave', () => {
  it('keeps a real accent, normalised, and everything else as it was', () => {
    expect(settingsForSave({ accent_color: '#abc', thank_you_message: 'Thanks', allow_attachments: true })).toEqual({
      accent_color: '#AABBCC',
      thank_you_message: 'Thanks',
      allow_attachments: true,
    });
  });

  it('never sends an accent the server would refuse, so the rest of the form still saves', () => {
    expect(settingsForSave({ accent_color: 'red', redirect_url: 'https://example.com/thanks' })).toEqual({
      accent_color: null,
      redirect_url: 'https://example.com/thanks',
    });
  });

  it('does not round-trip the outside logo link', () => {
    const out = settingsForSave({ accent_color: null, logo_url: 'https://elsewhere.example/logo.png' } as never);
    expect(out).toEqual({ accent_color: null });
    expect(Object.prototype.hasOwnProperty.call(out, 'logo_url')).toBe(false);
  });
});
