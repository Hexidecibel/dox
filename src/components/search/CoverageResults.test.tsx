import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CoverageResults } from './CoverageResults';
import type { SearchConstraint, SearchConstraintCheck } from '../../../shared/types';

const constraint: SearchConstraint = {
  id: 'c1', kind: 'date', label: 'production date Jul 31, 2026', raw: '7/31/2026', value: '2026-07-31',
  fields: ['production_date'], role: 'production', date_from: '2026-07-31', date_to: '2026-07-31', source: 'query_text',
};

const roleMismatch: SearchConstraintCheck = {
  constraint_id: 'c1', outcome: 'role_mismatch', field: 'code_date', field_label: 'code date', value: '2026-07-31',
  provenance: 'extracted',
  message: "This document's code date is Jul 31, 2026, but you asked for the production date — a code date is not a production date.",
};

const wrap = (ui: React.ReactNode) => <MemoryRouter>{ui}</MemoryRouter>;

describe('CoverageResults', () => {
  it('A11: leads with "No covering document on file", then a separate labelled candidates section', () => {
    render(wrap(
      <CoverageResults
        coverage="none"
        constraints={[constraint]}
        coverage_summary="No document on file covers production date Jul 31, 2026."
        documents={[{ id: 'wp', title: 'West Point Butter', match_status: 'candidate_not_matching', match_checks: [roleMismatch] }]}
        unreviewed_candidates={[{
          queue_id: 'q1', file_name: 'Darigold COA.pdf', supplier: 'Darigold, Inc.', created_at: null,
          review_url: '/review?item=q1', match_status: 'unreviewed_candidate', matches_all_constraints: true,
          record_label: null, match_checks: [], match_reason: 'Matches what you asked for, but it is still in the Review Queue.',
        }]}
      />,
    ));
    const banner = screen.getByTestId('no-coverage-banner');
    expect(within(banner).getByText('No covering document on file')).toBeInTheDocument();
    expect(banner).toHaveTextContent('No document on file covers production date Jul 31, 2026.');
    expect(screen.queryByText(/Covering documents/)).not.toBeInTheDocument();

    const candidates = screen.getByTestId('candidates-section');
    expect(within(candidates).getByText(/does not match/)).toBeInTheDocument();
    expect(within(candidates).getByText('West Point Butter')).toBeInTheDocument();
    expect(within(candidates).getByText(/a code date is not a production date/)).toBeInTheDocument();

    const unreviewed = screen.getByTestId('unreviewed-section');
    expect(within(unreviewed).getByText('Darigold COA.pdf')).toBeInTheDocument();
    expect(within(unreviewed).getByRole('link')).toHaveAttribute('href', '/review?item=q1');
  });

  it('shows covering documents with their evidence and provenance', () => {
    render(wrap(
      <CoverageResults
        coverage="covered"
        constraints={[constraint]}
        coverage_summary="1 document on file covers production date Jul 31, 2026."
        documents={[{
          id: 'd1', title: 'Butter COA', match_status: 'covering',
          match_checks: [{ ...roleMismatch, outcome: 'match', field: 'production_date', field_label: 'production date', message: 'The production date on this document is Jul 31, 2026.' }],
        }]}
      />,
    ));
    expect(screen.getByText('Covering documents (1)')).toBeInTheDocument();
    expect(screen.getByTestId('evidence-covering')).toHaveTextContent('production date, read from the document');
    expect(screen.queryByTestId('no-coverage-banner')).not.toBeInTheDocument();
  });

  it('says out loud what could not be applied', () => {
    render(wrap(
      <CoverageResults
        coverage="none"
        constraints={[constraint]}
        dropped_constraints={[{ kind: 'document_type', label: 'document type nope', raw: 'nope', reason: 'there is no document type by that name in this workspace.' }]}
        coverage_summary="x"
        documents={[]}
      />,
    ));
    expect(screen.getByText('Part of your search could not be applied')).toBeInTheDocument();
  });
});
