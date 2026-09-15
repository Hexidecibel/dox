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
  SpecRowMarker,
  SpecWarningBanner,
  conversionFromSnapshot,
} from './SpecWarnings';
import type { SpecVerdict } from '../lib/types';

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

describe('SpecWarningBanner keeps could-not-check apart from out-of-spec', () => {
  it('labels an unjudgeable result as verify, not as a failure', () => {
    render(
      <SpecWarningBanner
        verdicts={[verdict({ verdict: 'not_checked', message: 'Coliform could not be judged — straddles.' })]}
      />
    );
    expect(screen.getByText(/could not be checked/i)).toBeTruthy();
    expect(screen.queryByText(/out-of-spec|fails/i)).toBeNull();
  });
});
