/**
 * Screen 4 — the five beats, and the two ways this screen could quietly do
 * harm.
 *
 * The beats are the feature: nothing pre-ticked, a second tick that earns one
 * sentence and a third that does not repeat it, a nudge that spends exactly one
 * press of Next and then gets out of the way, and a "Show me" that ticks the
 * pack's own answer. They are asserted because they are the only thing this
 * screen produces — it collects one mapping and teaches an idea, and a
 * regression in the teaching is invisible to every other test in the suite.
 *
 * The harm is subtler and worth naming. The write is a REPLACE against a type
 * that already carries the pack's mapping, so two behaviours are load-bearing:
 * opening the screen and touching nothing must write nothing at all, and the
 * write must name the taught type and no other. Either one, wrong, silently
 * deletes configuration on a screen that exists to explain what that
 * configuration is for.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCallback, useRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  ApiDocumentType,
  ApiRequirement,
  StarterPackCatalogEntry,
  TenantSetupRun,
} from '../../lib/types';
import type { SetupStepProps } from './stepProps';

const listRequirements = vi.fn();
const listTypes = vi.fn();
const listDtr = vi.fn();
const replaceDtr = vi.fn();

// react-pdf pulls a worker and a canvas that jsdom/happy-dom has no answer for,
// and none of the beats live on the left-hand pane. The stub keeps the url
// assertable so "the screen renders the pack's sample" is still a fact.
vi.mock('../../components/PdfViewer', () => ({
  default: ({ url }: { url: string }) => <div data-testid="pdf">{url}</div>,
}));

vi.mock('../../lib/api', () => ({
  api: {
    requirements: { list: (...a: unknown[]) => listRequirements(...a) },
    documentTypes: { list: (...a: unknown[]) => listTypes(...a) },
    documentTypeRequirements: {
      list: (...a: unknown[]) => listDtr(...a),
      replace: (...a: unknown[]) => replaceDtr(...a),
    },
  },
}));

import { StepTeach, readTeachState, teachProgress } from './StepTeach';

// ---- fixtures --------------------------------------------------------------

function requirement(slug: string, name: string, checklist: string): ApiRequirement {
  return {
    id: `req_${slug}`,
    tenant_id: 't1',
    slug,
    name,
    description: null,
    checklist,
    sort_order: 0,
    active: 1,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  };
}

function documentType(slug: string, name: string): ApiDocumentType {
  return {
    id: `dt_${slug}`,
    tenant_id: 't1',
    name,
    slug,
    description: null,
    supplier_id: null,
    auto_ingest_threshold: null,
    auto_ingest: 0,
    extract_tables: 0,
    renewal_interval_months: null,
    renewal_policy: 'period',
    default_owner: null,
    active: 1,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  };
}

/** Five line items, three of which the taught document genuinely closes. */
const REQUIREMENTS: ApiRequirement[] = [
  requirement('spec-sheet', 'Specification sheet on file', 'Product'),
  requirement('micro-limits', 'Micro limits', 'Product'),
  requirement('pack-size', 'Pack size', 'Product'),
  requirement('coa-on-file', 'COA on file', 'Lot'),
  requirement('audit-cert', 'Third-party audit certificate', 'Facility'),
];

const TYPES: ApiDocumentType[] = [
  documentType('specification-sheet', 'Specification Sheet'),
  documentType('certificate-of-analysis', 'Certificate of Analysis'),
];

const PACK: StarterPackCatalogEntry = {
  pack: 'fsqa',
  label: 'Food Safety',
  description: '',
  sections: [],
  owner_labels: [],
  total_rows: 0,
  modules: { default_on: [], default_off: [] },
  packets: [],
  teach: {
    document_type: 'specification-sheet',
    closes: ['spec-sheet', 'micro-limits', 'pack-size'],
    decoy: 'coa-on-file',
    decoy_reason: 'A specification measures nothing.',
    also_closed_by: { requirement: 'coa-on-file', document_type: 'certificate-of-analysis' },
    sample_file: '/setup-samples/fsqa/specification-sheet.pdf',
  },
};

const run: TenantSetupRun = {
  id: 'run1',
  tenant_id: 't1',
  status: 'draft',
  current_step: 4,
  pack: 'fsqa',
  state: {},
  applied: {},
  started_by: 'u1',
  started_at: '2026-09-03T00:00:00Z',
  updated_at: '2026-09-03T00:00:00Z',
  completed_at: null,
  completed_by: null,
};

function props(over: Partial<SetupStepProps> = {}): SetupStepProps {
  return {
    run,
    tenantId: 't1',
    catalog: null,
    pack: PACK,
    preSeeded: null,
    patchState: vi.fn(),
    refreshRun: vi.fn().mockResolvedValue(undefined),
    goToStep: vi.fn(),
    setNextIntercept: vi.fn(),
    finish: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

/**
 * The shell's Next button, reproduced exactly as `SetupWizard.tsx` wires it:
 * consult the screen's intercept, and advance unless it claims the press.
 *
 * Rendered here rather than mounting the whole wizard (which would need the
 * router, both contexts and four more endpoints stubbed) so the one property
 * that matters — the button is never disabled, and a second press always
 * advances — can be asserted against a real click.
 */
function Harness({ onAdvance, ...stepProps }: SetupStepProps & { onAdvance: () => void }) {
  const interceptRef = useRef<(() => boolean) | null>(null);
  const setNextIntercept = useCallback((fn: (() => boolean) | null) => {
    interceptRef.current = fn;
  }, []);
  return (
    <>
      <StepTeach {...stepProps} setNextIntercept={setNextIntercept} />
      <button
        type="button"
        onClick={() => {
          const intercept = interceptRef.current;
          if (intercept && intercept()) return;
          onAdvance();
        }}
      >
        Next
      </button>
    </>
  );
}

async function renderStep(over: Partial<SetupStepProps> = {}) {
  const p = props(over);
  render(<StepTeach {...p} />);
  await screen.findByTestId('teach-counter');
  return p;
}

function box(name: string): HTMLElement {
  return screen.getByRole('checkbox', { name });
}

beforeEach(() => {
  vi.clearAllMocks();
  listRequirements.mockResolvedValue({
    requirements: REQUIREMENTS,
    total: REQUIREMENTS.length,
    limit: 500,
    offset: 0,
  });
  listTypes.mockResolvedValue({ documentTypes: TYPES });
  // The mirror's count, read back rather than asserted: in this vocabulary a
  // certificate of analysis closes exactly one line item.
  listDtr.mockResolvedValue({
    tenant_id: 't1',
    document_type_id: 'dt_certificate-of-analysis',
    requirements: [
      {
        requirement_id: 'req_coa-on-file',
        requirement_name: 'COA on file',
        requirement_slug: 'coa-on-file',
        requirement_checklist: 'Lot',
        source: 'pack',
      },
    ],
  });
  replaceDtr.mockResolvedValue({
    tenant_id: 't1',
    document_type_id: 'dt_specification-sheet',
    requirements: [],
    added: 0,
    removed: 0,
  });
});

// ---- pure helpers ----------------------------------------------------------

describe('readTeachState', () => {
  it('treats a missing or malformed blob as a first visit', () => {
    expect(readTeachState(undefined).ticked).toEqual([]);
    expect(readTeachState({ step4: 'nonsense' }).nudge_shown).toBe(false);
    expect(readTeachState({ step4: { ticked: ['a', 7, null] } }).ticked).toEqual(['a']);
  });

  it('reads the four things the screen records', () => {
    expect(
      readTeachState({
        step4: {
          ticked: ['micro-limits'],
          nudge_shown: true,
          nudge_accepted: false,
          decoy_expanded: true,
        },
      }),
    ).toEqual({
      ticked: ['micro-limits'],
      nudge_shown: true,
      nudge_accepted: false,
      decoy_expanded: true,
    });
  });
});

describe('teachProgress', () => {
  it('counts against the document, not against the tick count', () => {
    // Three ticks, only one of which is on this document, is one found — not
    // three. "Six more to find" has to mean six things that are actually there.
    expect(teachProgress(['req_spec-sheet', 'req_coa-on-file', 'req_audit-cert'], [
      'req_spec-sheet',
      'req_micro-limits',
      'req_pack-size',
    ])).toEqual({ found: 1, total: 3, remaining: 2 });
  });
});

// ---- the beats -------------------------------------------------------------

describe('StepTeach', () => {
  it('opens with nothing ticked, on a tenant whose type is already mapped', async () => {
    // The pack seeded this type's nine rows before anybody arrived. The screen
    // deliberately does not read them: an exercise whose answer is already on
    // the page teaches nothing.
    await renderStep();
    expect(screen.getByTestId('teach-counter')).toHaveTextContent('Closes 0 of 5');
    for (const b of screen.getAllByRole('checkbox')) expect(b).not.toBeChecked();
    expect(screen.getByTestId('pdf')).toHaveTextContent(
      '/setup-samples/fsqa/specification-sheet.pdf',
    );
  });

  it('leaves the first tick unrewarded, and earns the sentence on the second', async () => {
    const user = userEvent.setup();
    await renderStep();

    await user.click(box('Specification sheet on file'));
    expect(screen.getByTestId('teach-counter')).toHaveTextContent('Closes 1 of 5');
    expect(screen.queryByText(/That is the idea/)).not.toBeInTheDocument();
    // Beat 3's panel has not fired early either.
    expect(screen.queryByTestId('teach-checklist')).not.toBeInTheDocument();

    await user.click(box('Micro limits'));
    expect(screen.getByTestId('teach-counter')).toHaveTextContent('Closes 2 of 5');
    expect(screen.getByText('One document. Two line items. That is the idea.')).toBeInTheDocument();
  });

  it('says the line once — a third tick does not repeat it, it redraws the checklist', async () => {
    const user = userEvent.setup();
    await renderStep();

    await user.click(box('Specification sheet on file'));
    await user.click(box('Micro limits'));
    await user.click(box('Pack size'));

    expect(screen.getAllByText('One document. Two line items. That is the idea.')).toHaveLength(1);
    // Beat 3: the supplier checklist, redrawn.
    expect(await screen.findByTestId('teach-checklist')).toBeInTheDocument();
    expect(screen.getByTestId('teach-open-count')).toHaveTextContent('5 open → 2 open');
  });

  it('nudges once under two ticks, and never disables Next', async () => {
    const user = userEvent.setup();
    const onAdvance = vi.fn();
    render(<Harness {...props()} onAdvance={onAdvance} />);
    await screen.findByTestId('teach-counter');

    await user.click(box('Specification sheet on file'));

    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeEnabled();

    // First press: spent on the nudge, in place, with no modal.
    await user.click(next);
    expect(onAdvance).not.toHaveBeenCalled();
    expect(screen.getByTestId('teach-nudge')).toHaveTextContent(
      'Most people tick one here. This sheet actually closes 3.',
    );
    expect(next).toBeEnabled();

    // Second press advances, whatever the screen thinks of the answer.
    await user.click(next);
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(next).toBeEnabled();
  });

  it('does not nudge somebody who already found two', async () => {
    const user = userEvent.setup();
    const onAdvance = vi.fn();
    render(<Harness {...props()} onAdvance={onAdvance} />);
    await screen.findByTestId('teach-counter');

    await user.click(box('Specification sheet on file'));
    await user.click(box('Micro limits'));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('teach-nudge')).not.toBeInTheDocument();
  });

  it('“Show me” ticks the pack’s own set and plays the second beat', async () => {
    const user = userEvent.setup();
    const onAdvance = vi.fn();
    render(<Harness {...props()} onAdvance={onAdvance} />);
    await screen.findByTestId('teach-counter');

    await user.click(box('Specification sheet on file'));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Show me' }));

    // Staggered, so this settles rather than arriving in one frame.
    await waitFor(
      () => expect(screen.getByTestId('teach-counter')).toHaveTextContent('Closes 3 of 5'),
      { timeout: 3000 },
    );
    expect(box('Micro limits')).toBeChecked();
    expect(box('Pack size')).toBeChecked();
    // Not the decoy, and not the line item this document has nothing to say
    // about.
    expect(box('COA on file')).not.toBeChecked();
    expect(box('Third-party audit certificate')).not.toBeChecked();
    expect(screen.getByText('One document. Two line items. That is the idea.')).toBeInTheDocument();
  });

  // ---- what it writes ------------------------------------------------------

  it('writes the taught type and no other, as source “wizard”', async () => {
    const user = userEvent.setup();
    await renderStep();

    await user.click(box('Specification sheet on file'));
    await user.click(box('Micro limits'));

    await waitFor(() => expect(replaceDtr).toHaveBeenCalled(), { timeout: 3000 });
    // Debounced: two ticks, one write, carrying both.
    expect(replaceDtr).toHaveBeenCalledTimes(1);
    expect(replaceDtr).toHaveBeenCalledWith({
      documentTypeId: 'dt_specification-sheet',
      requirementIds: ['req_spec-sheet', 'req_micro-limits'],
      source: 'wizard',
    });
    // The pack already mapped the other types. This screen must never touch
    // one of them — mapping twenty-seven types by hand is the data entry it
    // exists to replace.
    for (const call of replaceDtr.mock.calls) {
      expect((call[0] as { documentTypeId: string }).documentTypeId).toBe(
        'dt_specification-sheet',
      );
    }
  });

  it('writes nothing at all when nobody ticks anything', async () => {
    // The PUT is a REPLACE and this type arrives carrying the pack's mapping.
    // A screen that wrote on mount, or on a tick-then-untick, would delete that
    // mapping silently.
    const user = userEvent.setup();
    await renderStep();
    await user.click(box('Micro limits'));
    await user.click(box('Micro limits'));

    await new Promise((r) => setTimeout(r, 900));
    expect(replaceDtr).not.toHaveBeenCalled();
  });

  it('restores the ticks after a reload, from what this person ticked', async () => {
    const patchState = vi.fn();
    await renderStep({
      patchState,
      run: {
        ...run,
        state: {
          step4: {
            ticked: ['spec-sheet', 'micro-limits', 'pack-size'],
            nudge_shown: true,
            nudge_accepted: true,
            decoy_expanded: false,
          },
        },
      },
    });

    expect(screen.getByTestId('teach-counter')).toHaveTextContent('Closes 3 of 5');
    expect(box('Specification sheet on file')).toBeChecked();
    expect(box('Pack size')).toBeChecked();
    // Restored, so the earned panels are simply there…
    expect(screen.getByText('One document. Two line items. That is the idea.')).toBeInTheDocument();
    expect(screen.getByTestId('teach-checklist')).toBeInTheDocument();
    // …and nothing was re-saved by the act of restoring.
    expect(patchState).not.toHaveBeenCalled();
    expect(replaceDtr).not.toHaveBeenCalled();
  });

  it('records the four things it measures, in slugs', async () => {
    const user = userEvent.setup();
    const patchState = vi.fn();
    await renderStep({ patchState });

    await user.click(box('Micro limits'));
    expect(patchState).toHaveBeenLastCalledWith({
      step4: {
        ticked: ['micro-limits'],
        nudge_shown: false,
        nudge_accepted: false,
        decoy_expanded: false,
      },
    });

    await user.click(screen.getByRole('button', { name: /Why not/ }));
    expect(patchState).toHaveBeenLastCalledWith({
      step4: {
        ticked: ['micro-limits'],
        nudge_shown: false,
        nudge_accepted: false,
        decoy_expanded: true,
      },
    });
  });

  // ---- the two contrasts ---------------------------------------------------

  it('names the decoy and states the type/requirement distinction', async () => {
    const user = userEvent.setup();
    await renderStep();
    await user.click(screen.getByRole('button', { name: /Why not “COA on file”/ }));

    expect(screen.getByText(/A specification measures nothing/)).toBeInTheDocument();
    expect(screen.getByText(/Same numbers, different claim/)).toBeInTheDocument();
    // The counts in that sentence come from the pack and from the API, not from
    // copy: three here, one for the certificate of analysis.
    expect(
      screen.getByText(/are different lists — which is why a specification sheet closes 3/),
    ).toHaveTextContent('a certificate of analysis closes 1');
  });

  it('runs the mapping the other way, with the mirror’s count read back', async () => {
    await renderStep();
    const mirror = await screen.findByTestId('teach-mirror');
    expect(mirror).toHaveTextContent('Specification Sheet');
    expect(mirror).toHaveTextContent('COA on file');
    await waitFor(() => expect(mirror).toHaveTextContent('closes 1 line item in total'));
    expect(listDtr).toHaveBeenCalledWith({ documentTypeId: 'dt_certificate-of-analysis' });
  });

  // ---- honest empty states -------------------------------------------------

  it('says so plainly when the pack ships no teaching example', async () => {
    render(<StepTeach {...props({ pack: { ...PACK, teach: null } })} />);
    expect(
      await screen.findByText(/This starter pack ships no teaching example/),
    ).toBeInTheDocument();
  });

  it('says so plainly when the taught type is not seeded here', async () => {
    listTypes.mockResolvedValue({ documentTypes: [documentType('other', 'Other')] });
    render(<StepTeach {...props()} />);
    expect(await screen.findByText(/has no/)).toBeInTheDocument();
    expect(replaceDtr).not.toHaveBeenCalled();
  });
});
