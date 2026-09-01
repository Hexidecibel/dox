/**
 * DocumentFacetPicker — the control that decides whether the registry's middle
 * layer holds real ids or unusable prose.
 *
 * The behaviours under test are the ones that are load-bearing rather than
 * cosmetic: only vocabulary is offerable, a person's tick lands `confirmed`
 * (the only status gap detection counts), unticking something a pipeline
 * proposed records a `rejected` row rather than deleting it, and the
 * draft<->payload round trip does not lose the junction fields that PUT would
 * otherwise delete.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DocumentFacetPicker,
  draftsFromLinks,
  linksFromDrafts,
  type FacetLinkDraft,
  type FacetLinkDraftMap,
} from './DocumentFacetPicker';

const VOCAB = [
  { id: 'req_a', name: 'Allergen Matrix', description: 'Per-SKU allergen grid', group: 'SOP 102.2' },
  { id: 'req_b', name: '100g Nutritionals', group: 'SOP 102.2' },
  { id: 'req_c', name: 'Letter of Guarantee', group: 'SOP 110' },
];

function drafts(...entries: FacetLinkDraft[]): FacetLinkDraftMap {
  return new Map(entries.map((e) => [e.id, e]));
}

describe('DocumentFacetPicker', () => {
  it('offers the tenant vocabulary, grouped, and nothing else', () => {
    render(
      <DocumentFacetPicker
        vocab={VOCAB}
        value={new Map()}
        onChange={() => {}}
        emptyMessage="none configured"
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Allergen Matrix' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '100g Nutritionals' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Letter of Guarantee' })).toBeInTheDocument();
    // Exactly the vocabulary — there is no free-text escape hatch.
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('SOP 102.2')).toBeInTheDocument();
    expect(screen.getByText('SOP 110')).toBeInTheDocument();
  });

  it('degrades to an empty state, not a broken control, with no vocabulary', () => {
    render(
      <DocumentFacetPicker
        vocab={[]}
        value={new Map()}
        onChange={() => {}}
        emptyMessage="This tenant has no checklist items yet."
      />,
    );
    expect(screen.getByText('This tenant has no checklist items yet.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('ticking a box records the link at the given status', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DocumentFacetPicker
        vocab={VOCAB}
        value={new Map()}
        onChange={onChange}
        emptyMessage="none"
      />,
    );
    await user.click(screen.getByRole('checkbox', { name: 'Allergen Matrix' }));
    const next: FacetLinkDraftMap = onChange.mock.calls[0][0];
    // 'confirmed' is the default: a person ticking a box IS the human decision,
    // and a 'suggested' link would not count toward gap detection.
    expect(next.get('req_a')).toMatchObject({ id: 'req_a', status: 'confirmed' });
  });

  it('unticking a link the pipeline proposed records a rejection, not a delete', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DocumentFacetPicker
        vocab={VOCAB}
        value={drafts({
          id: 'req_a',
          status: 'suggested',
          originalStatus: 'suggested',
          source: 'extraction',
          confidence: 0.8,
        })}
        onChange={onChange}
        showStatus
        emptyMessage="none"
      />,
    );
    await user.click(screen.getByRole('checkbox', { name: 'Allergen Matrix' }));
    const next: FacetLinkDraftMap = onChange.mock.calls[0][0];
    expect(next.get('req_a')).toMatchObject({ status: 'rejected', source: 'extraction' });
  });

  it('unticking a link the user just added simply drops it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DocumentFacetPicker
        vocab={VOCAB}
        value={drafts({ id: 'req_a', status: 'confirmed' })}
        onChange={onChange}
        emptyMessage="none"
      />,
    );
    await user.click(screen.getByRole('checkbox', { name: 'Allergen Matrix' }));
    const next: FacetLinkDraftMap = onChange.mock.calls[0][0];
    expect(next.has('req_a')).toBe(false);
  });

  it('shows provenance and a status toggle only when reviewing', () => {
    const value = drafts({
      id: 'req_a',
      status: 'suggested',
      originalStatus: 'suggested',
      source: 'extraction',
      confidence: 0.91,
    });
    const { rerender } = render(
      <DocumentFacetPicker vocab={VOCAB} value={value} onChange={() => {}} emptyMessage="none" />,
    );
    expect(screen.queryByRole('button', { name: 'Confirmed' })).not.toBeInTheDocument();

    rerender(
      <DocumentFacetPicker vocab={VOCAB} value={value} onChange={() => {}} showStatus emptyMessage="none" />,
    );
    expect(screen.getByRole('button', { name: 'Confirmed' })).toBeInTheDocument();
    expect(screen.getByText(/Proposed by extraction/)).toBeInTheDocument();
    expect(screen.getByText(/91% confidence/)).toBeInTheDocument();
  });

  it('promotes a suggestion to confirmed through the status toggle', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DocumentFacetPicker
        vocab={VOCAB}
        value={drafts({ id: 'req_a', status: 'suggested', originalStatus: 'suggested' })}
        onChange={onChange}
        showStatus
        emptyMessage="none"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Confirmed' }));
    const next: FacetLinkDraftMap = onChange.mock.calls[0][0];
    expect(next.get('req_a')?.status).toBe('confirmed');
  });

  it('a rejected link reads as a recorded "no", not as absent', () => {
    render(
      <DocumentFacetPicker
        vocab={VOCAB}
        value={drafts({ id: 'req_a', status: 'rejected', originalStatus: 'suggested' })}
        onChange={() => {}}
        showStatus
        emptyMessage="none"
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Allergen Matrix' })).not.toBeChecked();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
  });

  it('shows a search box only once the list is long enough to need one', () => {
    const long = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, name: `Item ${i}` }));
    render(
      <DocumentFacetPicker vocab={long} value={new Map()} onChange={() => {}} emptyMessage="none" />,
    );
    expect(screen.getByPlaceholderText('Search…')).toBeInTheDocument();
  });
});

describe('draftsFromLinks', () => {
  it('keys drafts by vocabulary id and remembers the server-side status', () => {
    const { drafts: d, passthrough } = draftsFromLinks(
      [
        { requirement_id: 'req_a', status: 'suggested', source: 'extraction', confidence: 0.7 },
        { requirement_id: 'req_b', status: 'confirmed', source: 'human', confidence: null },
      ],
      'requirement_id',
    );
    expect([...d.keys()]).toEqual(['req_a', 'req_b']);
    expect(d.get('req_a')).toMatchObject({ status: 'suggested', originalStatus: 'suggested' });
    expect(d.get('req_b')).toMatchObject({ status: 'confirmed', originalStatus: 'confirmed' });
    expect(passthrough).toEqual([]);
  });

  it('keeps a second link on the same vocabulary id as passthrough', () => {
    // Two claims of the same type about different subjects are legal (the
    // junction's uniqueness guard includes the subject) but the checkbox list
    // is keyed by vocabulary id, so the extra must survive some other way.
    const { drafts: d, passthrough } = draftsFromLinks(
      [
        { claim_type_id: 'ct_1', status: 'confirmed', subject_type: 'tenant', subject_id: null },
        { claim_type_id: 'ct_1', status: 'confirmed', subject_type: 'supplier', subject_id: 'sup_9' },
      ],
      'claim_type_id',
    );
    expect(d.size).toBe(1);
    expect(passthrough).toHaveLength(1);
    expect(passthrough[0]).toMatchObject({ subject_type: 'supplier', subject_id: 'sup_9' });
  });

  it('treats an undefined link set as empty', () => {
    const { drafts: d, passthrough } = draftsFromLinks(undefined, 'requirement_id');
    expect(d.size).toBe(0);
    expect(passthrough).toEqual([]);
  });
});

describe('linksFromDrafts', () => {
  it('emits id + status, and carries provenance back so PUT cannot lose it', () => {
    const out = linksFromDrafts(
      drafts({
        id: 'req_a',
        status: 'confirmed',
        source: 'extraction',
        confidence: 0.42,
        notes: 'from page 2',
      }),
    );
    expect(out).toEqual([
      { id: 'req_a', status: 'confirmed', source: 'extraction', confidence: 0.42, notes: 'from page 2' },
    ]);
  });

  it('drops a source the endpoint would reject rather than failing the save', () => {
    const out = linksFromDrafts(drafts({ id: 'req_a', status: 'confirmed', source: 'mystery-pipeline' }));
    expect(out[0]).not.toHaveProperty('source');
  });

  it('omits the subject pair for a tenant-scoped claim', () => {
    // validateClaimSubjects rejects a tenant-scoped claim that carries a
    // subject_id, so the default scope must be sent as nothing at all.
    const out = linksFromDrafts(drafts({ id: 'ct_1', status: 'confirmed', subject_type: 'tenant', subject_id: null }));
    expect(out[0]).not.toHaveProperty('subject_type');
    expect(out[0]).not.toHaveProperty('subject_id');
  });

  it('keeps a real subject and appends passthrough links', () => {
    const out = linksFromDrafts(
      drafts({ id: 'ct_1', status: 'confirmed' }),
      [{ id: 'ct_1', status: 'confirmed', subject_type: 'supplier', subject_id: 'sup_9' }],
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ id: 'ct_1', subject_type: 'supplier', subject_id: 'sup_9' });
  });

  it('resends rejected links so a REPLACE does not erase the decision', () => {
    const out = linksFromDrafts(
      drafts(
        { id: 'req_a', status: 'confirmed' },
        { id: 'req_b', status: 'rejected', originalStatus: 'suggested' },
      ),
    );
    expect(out).toEqual([
      { id: 'req_a', status: 'confirmed' },
      { id: 'req_b', status: 'rejected' },
    ]);
  });
});
