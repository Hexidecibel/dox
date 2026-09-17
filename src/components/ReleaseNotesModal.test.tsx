/**
 * Release notes — the reach chip, rendered from what a human typed.
 *
 * The convention is a token at the head of a bullet, written by hand into a
 * markdown file. Two things have to hold for that to be safe:
 *
 *   1. A MARKED BULLET SHOWS THE CLAIM, not the literal `[existing]`. In
 *      particular the token survives markdown's two list shapes — a tight list
 *      hands the renderer a bare string, a loose one wraps it in a paragraph
 *      first — and a renderer that only handled one would leave raw brackets on
 *      half the release pages.
 *   2. AN UNMARKED BULLET IS UNTOUCHED. Every release before v2.8.0 has none,
 *      and notes will be written in a hurry forever.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { ReleaseNotesModal } from './ReleaseNotesModal';

const INDEX = {
  current: '9.9.9',
  versions: [{ version: '9.9.9', date: '2026-09-17', title: 'Test release' }],
};

/** A tight list (no blank lines) and a loose one (blank lines between items). */
const NOTES = `---
version: 9.9.9
---

## Test release

- [existing] Everybody has this now.
- [new-orgs] A changed default.
- [config] Inert until set up.
- Nobody classified this one.

## Loose list

- [config] Wrapped in a paragraph by markdown.

- Also wrapped, and unmarked.
`;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('index.json')) {
        return new Response(JSON.stringify(INDEX), { status: 200 });
      }
      return new Response(NOTES, { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReleaseNotesModal reach chips', () => {
  it('turns each token into the claim it stands for, in both list shapes', async () => {
    render(<ReleaseNotesModal open onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Reaches every organisation now')).toBeInTheDocument();
    });
    expect(screen.getByText('New organisations only')).toBeInTheDocument();
    // Two [config] bullets: one in the tight list, one markdown wrapped in a
    // paragraph. Both must be chipped.
    expect(screen.getAllByText('Needs configuration')).toHaveLength(2);

    // And the raw token never reaches the page.
    expect(screen.queryByText(/\[existing\]/)).toBeNull();
    expect(screen.queryByText(/\[config\]/)).toBeNull();
  });

  it('leaves an unmarked bullet exactly as written', async () => {
    render(<ReleaseNotesModal open onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText('Nobody classified this one.')).toBeInTheDocument();
    });
    expect(screen.getByText('Also wrapped, and unmarked.')).toBeInTheDocument();
  });
});
