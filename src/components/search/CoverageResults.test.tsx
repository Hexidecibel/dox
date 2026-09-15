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
  it('A1: names the lot row a result was judged on, with its production date and pack', () => {
    render(wrap(
      <CoverageResults
        coverage="covered"
        constraints={[{ ...constraint, id: 'c1', kind: 'lot', label: 'lot 10426203 · sublot 03', raw: '10426203 03', value: '1042620303', fields: ['lot'] }]}
        coverage_summary="1 document on file covers lot 10426203 · sublot 03."
        documents={[{
          id: 'd3', title: 'SWEET CREAM BUTTER', match_status: 'covering', match_checks: [],
          matched_lot: {
            lot_id: 'l3', lot_number: '10426203', sub_lot_code: '03', lot_key: '1042620303',
            production_date: '2026-07-22', production_date_raw: '22-Jul-2026', production_date_source: 'extracted',
            production_date_status: 'resolved', quantity: '50 EA', net_weight: '2755.75 LB',
          },
        }]}
      />,
    ));
    const row = screen.getByTestId('matched-lot');
    expect(row).toHaveTextContent('Lot 10426203 · sublot 03 · produced Jul 22, 2026 · 50 EA · 2755.75 LB');
    expect(row).toHaveTextContent('Production date read from the document');
  });

  it('a legacy-derived production date is a separate "likely — confirm" section, with its provenance', () => {
    render(wrap(
      <CoverageResults
        coverage="likely"
        constraints={[constraint]}
        coverage_summary="No document on file is confirmed to cover production date Jul 31, 2026. 1 likely does, on a production date an older extraction filed as the code date — open it to confirm."
        documents={[{
          id: 'dl', title: 'Older Darigold', match_status: 'likely_covering',
          match_checks: [{ ...roleMismatch, outcome: 'likely', field: 'production_date', field_label: 'production date', provenance: 'extracted_code_date_legacy', message: 'The production date on this lot row is Jul 31, 2026 — read from the code date field.' }],
          matched_lot: {
            lot_id: 'l', lot_number: '10426212', sub_lot_code: '01', lot_key: '1042621201',
            production_date: '2026-07-31', production_date_raw: '07/31/2026', production_date_source: 'extracted_code_date_legacy',
            production_date_status: 'resolved', quantity: null, net_weight: null,
          },
        }]}
      />,
    ));
    expect(screen.getByTestId('likely-coverage-banner')).toHaveTextContent('No confirmed covering document — 1 likely');
    expect(screen.queryByText(/Covering documents/)).not.toBeInTheDocument();
    const section = screen.getByTestId('likely-section');
    expect(section).toHaveTextContent('Likely covering — confirm (1)');
    expect(section).toHaveTextContent("Production date read from the document's code date field — older extraction. Confirm on the certificate");
  });

  it('an ambiguous product phrase says "could mean", with each product\'s own answer, and picks nothing', () => {
    const candidate = (product_id: string, label: string, covering: number) => ({
      product_id, product_name: label, label, our_skus: [], supplier_items: [], supplier_names: [], pack: '300 gal tote',
      matched_via: [], confirmed: true, conversion_note: null, explanation: label, covering_count: covering, likely_count: 0,
    });
    const productConstraint: SearchConstraint = {
      id: 'c2', kind: 'product', label: 'product "300 gal tote" (could mean 2 products)', raw: '300 gal tote', value: 'a,b',
      fields: ['product_code'], source: 'query_text',
      product_resolution: {
        phrase: '300 gal tote', ambiguous: true, message: '"300 gal tote" could mean 2 products',
        candidates: [candidate('a', 'MS WHOLE 300GL (our SKU 10284)', 1), candidate('b', '40% CREAM 300GL (our SKU 10286)', 0)],
      },
    };
    render(wrap(
      <CoverageResults
        coverage="ambiguous"
        constraints={[constraint, productConstraint]}
        coverage_summary='"300 gal tote" could mean 2 products, so nothing is picked.'
        documents={[]}
      />,
    ));
    const note = screen.getByTestId('product-ambiguity');
    expect(note).toHaveTextContent('“300 gal tote” could mean 2 products');
    expect(note).toHaveTextContent('MS WHOLE 300GL (our SKU 10284) — 1 covering');
    expect(note).toHaveTextContent('40% CREAM 300GL (our SKU 10286) — no covering document on file');
    expect(screen.getByTestId('ambiguous-coverage-banner')).toHaveTextContent('so nothing is picked');
  });
});
