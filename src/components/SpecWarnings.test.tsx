/**
 * The review-queue spec panel — what a reviewer can tell apart at a glance.
 *
 * SME rulings (2026-09-14) this file pins:
 *   - a unit conversion behind a comparison is a visible chip on that value;
 *   - "could not check" (verify it) never looks like "out of spec" (it is out).
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  ConversionChip,
  SpecAlertChip,
  SpecRowMarker,
  SpecWarningBanner,
  conversionFromSnapshot,
} from './SpecWarnings';
import { buildResultRows, ResultStateChip, RESULT_STATE_LABEL } from './DocumentSpecResults';
import type { SpecVerdict, UnjudgedResult, MissingRequiredAnalyte, ApiSpecCheck, ApiSpecGap } from '../lib/types';

const verdict = (over: Partial<SpecVerdict>): SpecVerdict => ({
  scope: 'ai_fields',
  target: { kind: 'table', table_index: 0, row_index: 0, table_name: '' },
  test_name_raw: 'Coliform',
  value_raw: '4',
  unit_raw: 'CFU/mL',
  verdict: 'in_spec',
  source: 'limit',
  limit_text: '≤10 CFU/g',
  reason: 'r',
  message: 'Coliform is 4, within our limit.',
  ...over,
});

describe('ConversionChip', () => {
  it('renders the conversion as words on the value', () => {
    render(
      <ConversionChip
        conversion={{ from: 'cfu/mL', to: 'CFU/g', rule: 'tenant_volume_mass', factor: 1, operation: '1:1' }}
      />
    );
    expect(screen.getByText('Converted: cfu/mL → CFU/g (tenant setting)')).toBeTruthy();
  });

  it('renders nothing when the value was compared as printed', () => {
    const { container } = render(<ConversionChip conversion={undefined} />);
    expect(container.textContent).toBe('');
  });

  it('shows on a row marker line that carries one', () => {
    render(
      <SpecRowMarker
        verdicts={[
          verdict({
            verdict: 'out_of_spec',
            message: 'Coliform is 5, outside our limit.',
            conversion: { from: 'cfu/0.1g', to: 'CFU/g', rule: 'sample_basis', factor: 10, operation: '× 10' },
          }),
        ]}
      />
    );
    expect(screen.getByText('Converted: cfu/0.1g → CFU/g (× 10)')).toBeTruthy();
  });
});

describe('conversionFromSnapshot', () => {
  it('reads the frozen conversion', () => {
    const c = conversionFromSnapshot(
      JSON.stringify({ conversion: { from: 'CFU/100g', to: 'CFU/g', rule: 'sample_basis', factor: 0.01, operation: '÷ 100' } }),
      'CFU/100g'
    );
    expect(c?.operation).toBe('÷ 100');
  });

  it('rebuilds a pre-conversion row judged under the 0093 equivalence', () => {
    const c = conversionFromSnapshot(JSON.stringify({ unit: 'CFU/g', unit_equivalence: 'volume_mass' }), 'CFU/mL');
    expect(c).toEqual({ from: 'CFU/mL', to: 'CFU/g', rule: 'tenant_volume_mass', factor: 1, operation: '1:1' });
  });

  it('returns null for a row with no conversion, or a corrupt snapshot', () => {
    expect(conversionFromSnapshot(JSON.stringify({ unit: 'CFU/g' }), 'CFU/g')).toBeNull();
    expect(conversionFromSnapshot('{not json', 'CFU/g')).toBeNull();
    expect(conversionFromSnapshot(null, 'CFU/g')).toBeNull();
  });
});

const unjudged = (over: Partial<UnjudgedResult> = {}): UnjudgedResult => ({
  scope: 'ai_fields',
  target: { kind: 'table', table_index: 0, row_index: 3, table_name: '' },
  test_name_raw: 'Somatic Cell Count',
  value_raw: '180000',
  unit_raw: 'per ml',
  state: 'unjudged',
  why: 'no_analyte',
  spec_test_id: null,
  reason: 'no configured analyte matches this name, and the certificate prints no specification for it',
  message: 'Somatic Cell Count: no limit configured — 180000 per ml was printed and not judged.',
  ...over,
});

const missing = (over: Partial<MissingRequiredAnalyte> = {}): MissingRequiredAnalyte => ({
  scope: 'ai_fields',
  state: 'missing_required',
  requirement_id: 'ra1',
  spec_test_id: 'st_coli',
  analyte_name: 'Coliform',
  why: 'not_on_certificate',
  printed_as: null,
  watch: null,
  requirement_reason: null,
  reason: 'required for this supplier, and not reported',
  message: 'Coliform is required for this supplier and is not on this certificate — the certificate is incomplete.',
  ...over,
});

describe('"No limit configured" is shown, in its own colour, and never as a pass', () => {
  it('renders a quiet panel on its own when nothing else was found', () => {
    render(<SpecWarningBanner verdicts={[]} unjudged={[unjudged()]} />);
    expect(screen.getByTestId('spec-no-limit-panel')).toBeTruthy();
    expect(screen.getByText('Somatic Cell Count: No limit configured')).toBeTruthy();
    // Not an alert: nothing here says out of spec or could-not-check.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the chip on the row it belongs to', () => {
    render(<SpecRowMarker verdicts={[]} unjudged={[unjudged()]} />);
    expect(screen.getByTestId('spec-no-limit-chip')).toBeTruthy();
  });

  it('renders nothing at all when there is nothing to say', () => {
    const { container } = render(<SpecWarningBanner verdicts={[]} unjudged={[]} />);
    expect(container.textContent).toBe('');
  });
});

describe('a missing required analyte is its own finding', () => {
  it('opens the banner as incomplete, once per analyte however many records miss it', () => {
    render(
      <SpecWarningBanner
        verdicts={[]}
        missingRequired={[missing({ scope: 'record[0]' }), missing({ scope: 'record[1]' })]}
      />
    );
    expect(screen.getByText(/This COA is incomplete — 1 required analyte is not reported/)).toBeTruthy();
    expect(screen.getByTestId('spec-missing-required').textContent).toContain('(2 records)');
  });

  it('flags a watch past its review-by date with the one label', () => {
    render(
      <SpecWarningBanner
        verdicts={[]}
        watchOverdue={[{ kind: 'limit', id: 'l1', spec_test_id: 'st', analyte_name: 'Coliform', review_by: '2026-09-01' }]}
      />
    );
    expect(screen.getByText('Watch period ended 2026-09-01 — review')).toBeTruthy();
    expect(screen.getByTestId('spec-watch-overdue').textContent).toContain('still applies');
  });

  it('puts an "incomplete" chip on the collapsed row', () => {
    render(<SpecAlertChip verdicts={[]} missingRequired={[missing()]} />);
    expect(screen.getByText('incomplete: 1 required')).toBeTruthy();
  });
});

describe('SpecWarningBanner keeps could-not-check apart from out-of-spec', () => {
  it('labels an unjudgeable result as verify, not as a failure', () => {
    render(
      <SpecWarningBanner
        verdicts={[verdict({ verdict: 'not_checked', message: 'Coliform could not be judged — straddles.' })]}
      />
    );
    expect(screen.getByText(/could not be checked — verify by hand/i)).toBeTruthy();
    expect(screen.queryByText(/out-of-spec|fails/i)).toBeNull();
  });

  it('prefixes the row line with "Could not check — verify", never with a failure word', () => {
    render(<SpecRowMarker verdicts={[verdict({ verdict: 'not_checked', message: 'Coliform straddles.' })]} />);
    expect(screen.getByText('Could not check — verify:')).toBeTruthy();
  });
});

describe('document page Test results — five states, five labels', () => {
  const check = (over: Partial<ApiSpecCheck>): ApiSpecCheck =>
    ({
      id: 'c',
      tenant_id: 't',
      document_id: 'd',
      version_number: 1,
      queue_item_id: null,
      spec_test_id: 'st',
      test_name_raw: 'Coliform',
      value_raw: '4',
      value_num: 4,
      unit_raw: 'CFU/mL',
      verdict: 'in_spec',
      reason: 'r',
      source: 'limit',
      limit_id: 'l',
      limit_snapshot: null,
      acknowledged_by: null,
      acknowledged_at: null,
      acknowledgement_note: null,
      notified_at: null,
      created_at: '2026-09-15',
      ...over,
    }) as ApiSpecCheck;
  const gap = (over: Partial<ApiSpecGap>): ApiSpecGap => ({
    id: 'g',
    tenant_id: 't',
    document_id: 'd',
    version_number: 1,
    queue_item_id: null,
    kind: 'unjudged',
    spec_test_id: null,
    required_analyte_id: null,
    test_name_raw: 'Fat',
    value_raw: '3.5',
    unit_raw: '%',
    result_key: 'ai_fields::t0r1',
    result_location: 'Table 1, row 2',
    reason: 'no configured analyte matches this name',
    snapshot: null,
    judgement_origin: 'approval',
    notified_at: null,
    created_at: '2026-09-15',
    ...over,
  });

  it('has a distinct label for every state', () => {
    const labels = Object.values(RESULT_STATE_LABEL);
    expect(new Set(labels).size).toBe(5);
    expect(RESULT_STATE_LABEL.unjudged).toBe('No limit configured');
  });

  it('orders the failures first and the passes last', () => {
    const rows = buildResultRows(
      [check({ id: 'a', verdict: 'in_spec' }), check({ id: 'b', verdict: 'out_of_spec' }), check({ id: 'c', verdict: 'not_checked' })],
      [gap({ id: 'd' }), gap({ id: 'e', kind: 'missing_required', spec_test_id: 'st', result_key: null, value_raw: null })]
    );
    expect(rows.map((r) => r.state)).toEqual(['out_of_spec', 'missing_required', 'not_checked', 'unjudged', 'in_spec']);
    expect(rows.find((r) => r.state === 'missing_required')?.value).toBe('—');
  });

  it('renders the no-limit state without the colour of a checked result', () => {
    const { container: noLimit } = render(<ResultStateChip state="unjudged" />);
    const { container: checked } = render(<ResultStateChip state="in_spec" />);
    expect(noLimit.querySelector('.MuiChip-colorSuccess')).toBeNull();
    expect(checked.querySelector('.MuiChip-colorSuccess')).not.toBeNull();
  });
});
