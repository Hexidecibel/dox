/**
 * RequestLineComposer — the behaviours that are load-bearing rather than
 * cosmetic.
 *
 * The one this control exists for: a typed line is the default and free text is
 * an exception you have to ask for. The API enforces that too (`resolveLines`
 * refuses an untyped line), but a UI that made both equally easy would satisfy
 * the letter of it and lose the point — every free-text line is a document the
 * registry cannot reason about.
 *
 * The rest is what a draft's save path depends on: the payload declares its
 * kind explicitly rather than leaning on a server default, and the diff a draft
 * edit produces is minimal — an untouched round trip must issue no writes at
 * all.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  RequestLineComposer,
  countDrafts,
  diffLineDrafts,
  draftFromFreeText,
  draftFromRequirement,
  draftsFromLines,
  draftsToLineInputs,
  toggleRequirement,
  type ExistingLine,
  type RequestLineDraft,
  type RequirementOption,
} from './RequestLineComposer';

const VOCAB: RequirementOption[] = [
  { id: 'req_a', name: 'Allergen Matrix', checklist: 'SOP 102.2' },
  { id: 'req_b', name: 'Letter of Guarantee', checklist: 'SOP 110' },
  { id: 'req_c', name: 'Organic Certificate', checklist: 'SOP 110' },
];

function renderComposer(
  value: RequestLineDraft[],
  onChange = vi.fn(),
  extra: Partial<React.ComponentProps<typeof RequestLineComposer>> = {},
) {
  render(
    <RequestLineComposer
      vocab={VOCAB}
      value={value}
      onChange={onChange}
      emptyMessage="No requirements configured."
      {...extra}
    />,
  );
  return onChange;
}

describe('RequestLineComposer — the picker', () => {
  it('offers the tenant checklist as the only ready-to-use way to add a line', () => {
    renderComposer([]);
    expect(screen.getByRole('checkbox', { name: 'Allergen Matrix' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Letter of Guarantee' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Organic Certificate' })).toBeInTheDocument();
    // Nothing on screen accepts free text until it is explicitly asked for:
    // with three requirements the search box is below its threshold too.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('ticking a requirement produces a TYPED line carrying the requirement id', async () => {
    const user = userEvent.setup();
    const onChange = renderComposer([]);
    await user.click(screen.getByRole('checkbox', { name: 'Allergen Matrix' }));
    const next: RequestLineDraft[] = onChange.mock.calls[0][0];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      line_kind: 'requirement',
      requirement_id: 'req_a',
      // The requirement's own name is the default wording, and stays editable.
      name: 'Allergen Matrix',
      tier: 'required',
    });
  });

  it('free text is not offered at rest — it takes a deliberate disclosure', async () => {
    const user = userEvent.setup();
    renderComposer([]);
    // No input to type an ask into...
    expect(screen.queryByLabelText('What to ask for')).not.toBeInTheDocument();
    // ...until the escape hatch is opened by name.
    await user.click(screen.getByRole('button', { name: /isn’t in the checklist/i }));
    expect(screen.getByLabelText('What to ask for')).toBeInTheDocument();
    // And it states the cost before it takes anything.
    expect(screen.getByText(/nothing that arrives can close it/i)).toBeInTheDocument();
  });

  it('refuses to add an empty free-text line, and adds a named one as free_text', async () => {
    const user = userEvent.setup();
    const onChange = renderComposer([]);
    await user.click(screen.getByRole('button', { name: /isn’t in the checklist/i }));

    const addButton = screen.getByRole('button', { name: 'Add anyway' });
    expect(addButton).toBeDisabled();

    await user.type(screen.getByLabelText('What to ask for'), 'Insurance rider');
    expect(addButton).toBeEnabled();
    await user.click(addButton);

    const calls = onChange.mock.calls;
    const next: RequestLineDraft[] = calls[calls.length - 1][0];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      line_kind: 'free_text',
      // The whole cost of the escape hatch, in one assertion.
      requirement_id: null,
      name: 'Insurance rider',
    });
  });

  it('floats what the supplier already owes to the top and flags it', () => {
    renderComposer([], vi.fn(), { outstanding: new Set(['req_c']) });
    expect(screen.getByText('Already outstanding for this supplier')).toBeInTheDocument();
    expect(screen.getByText('outstanding')).toBeInTheDocument();
  });

  it('degrades to an explanation, not a broken control, with no vocabulary', () => {
    render(
      <RequestLineComposer
        vocab={[]}
        value={[]}
        onChange={() => {}}
        emptyMessage="No requirements configured."
      />,
    );
    expect(screen.getByText('No requirements configured.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('says on the line, and in the total, which lines the registry cannot reason about', () => {
    renderComposer([
      draftFromRequirement(VOCAB[0]),
      draftFromFreeText('Insurance rider'),
    ]);
    // The header sentence names the free-text count as its own number, rather
    // than leaving it to be discovered by scrolling the list.
    expect(screen.getByText('1 free text')).toBeInTheDocument();
    expect(
      screen.getByText(/nothing can satisfy this line, and it is never counted as missing/i),
    ).toBeInTheDocument();
  });
});

describe('toggleRequirement', () => {
  it('adds on first tick and removes on the second', () => {
    const once = toggleRequirement([], VOCAB[0]);
    expect(once).toHaveLength(1);
    expect(toggleRequirement(once, VOCAB[0])).toHaveLength(0);
  });
});

describe('draftsToLineInputs', () => {
  it('declares line_kind explicitly on BOTH kinds rather than leaning on the default', () => {
    const inputs = draftsToLineInputs([
      draftFromRequirement(VOCAB[0]),
      draftFromFreeText('Insurance rider'),
    ]);
    expect(inputs[0].line_kind).toBe('requirement');
    expect(inputs[0].requirement_id).toBe('req_a');
    expect(inputs[1].line_kind).toBe('free_text');
    expect(inputs[1].requirement_id).toBeUndefined();
  });

  it('sends blank optional fields as null, not as empty strings', () => {
    const [input] = draftsToLineInputs([draftFromRequirement(VOCAB[0])]);
    expect(input.explanation).toBeNull();
    expect(input.acceptable_formats).toBeNull();
    expect(input.criteria).toBeNull();
    expect(input.owner).toBeNull();
  });

  it('numbers sort_order by position so the packet arrives in the composed order', () => {
    const inputs = draftsToLineInputs([
      draftFromRequirement(VOCAB[1]),
      draftFromRequirement(VOCAB[0]),
    ]);
    expect(inputs.map((i) => i.sort_order)).toEqual([0, 1]);
  });
});

describe('countDrafts', () => {
  it('splits typed from free text', () => {
    expect(
      countDrafts([
        draftFromRequirement(VOCAB[0]),
        draftFromRequirement(VOCAB[1]),
        draftFromFreeText('Insurance rider'),
      ]),
    ).toEqual({ total: 3, typed: 2, freeText: 1 });
  });
});

describe('diffLineDrafts — what editing a draft actually writes', () => {
  const existing: ExistingLine[] = [
    {
      id: 'line_1',
      line_kind: 'requirement',
      requirement_id: 'req_a',
      name: 'Allergen Matrix',
      explanation: null,
      acceptable_formats: null,
      criteria: null,
      owner: null,
      tier: 'required',
      sort_order: 0,
    },
    {
      id: 'line_2',
      line_kind: 'free_text',
      requirement_id: null,
      name: 'Insurance rider',
      explanation: null,
      acceptable_formats: null,
      criteria: null,
      owner: null,
      tier: 'recommended',
      sort_order: 1,
    },
  ];

  it('an untouched round trip writes nothing at all', () => {
    expect(diffLineDrafts(existing, draftsFromLines(existing))).toEqual({
      add: [],
      remove: [],
      update: [],
    });
  });

  it('a new tick is an add, keyed by requirement', () => {
    const drafts = [...draftsFromLines(existing), draftFromRequirement(VOCAB[1])];
    const diff = diffLineDrafts(existing, drafts);
    expect(diff.remove).toEqual([]);
    expect(diff.update).toEqual([]);
    expect(diff.add).toHaveLength(1);
    expect(diff.add[0]).toMatchObject({ requirement_id: 'req_b', line_kind: 'requirement' });
  });

  it('an untick is a remove of that line id', () => {
    const drafts = draftsFromLines(existing).filter((d) => d.line_kind !== 'free_text');
    const diff = diffLineDrafts(existing, drafts);
    expect(diff.remove).toEqual(['line_2']);
    expect(diff.add).toEqual([]);
  });

  it('rewording sends only what changed', () => {
    const drafts = draftsFromLines(existing);
    drafts[0] = { ...drafts[0], name: 'The allergen statement your QA team signs' };
    const diff = diffLineDrafts(existing, drafts);
    expect(diff.update).toEqual([
      { id: 'line_1', patch: { name: 'The allergen statement your QA team signs' } },
    ]);
  });

  it('identifies a typed line by its requirement, not its wording', () => {
    // Renaming a typed line must be an UPDATE, never a remove-plus-add: the
    // latter would drop the line and re-create it under a new id.
    const drafts = draftsFromLines(existing);
    drafts[0] = { ...drafts[0], name: 'Something else entirely' };
    const diff = diffLineDrafts(existing, drafts);
    expect(diff.remove).toEqual([]);
    expect(diff.add).toEqual([]);
  });

  it('identifies a free-text line only by its name — the other cost of the hatch', () => {
    // Renaming free text IS a different line, because there is nothing better
    // to identify it by. Same rule the server uses when carrying progress
    // across an amendment.
    const drafts = draftsFromLines(existing);
    drafts[1] = { ...drafts[1], name: 'Insurance certificate' };
    const diff = diffLineDrafts(existing, drafts);
    expect(diff.remove).toEqual(['line_2']);
    expect(diff.add).toHaveLength(1);
  });
});
