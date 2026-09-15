/**
 * Screen 4 — "One document, several boxes". THE REASON THE WIZARD EXISTS.
 *
 * Every other screen either collects a prerequisite (1-3), reports what now
 * exists (5) or shows the machine working (6). This is the only one that
 * introduces an IDEA, and it is the idea the domain expert who wrote the
 * requirements himself did not get from the config screens: a document's TYPE
 * and the checklist line items it CLOSES are two different lists. One
 * specification sheet closes nine of them. A certificate of analysis — which
 * carries the same numbers on the same page — closes exactly one.
 *
 * SO IT TEACHES AND BARELY COLLECTS. The only thing written from here is one
 * type's `document_type_requirements` mapping. The pack already seeded the
 * other twenty-six; making somebody map twenty-seven types would turn the
 * lesson straight back into the data entry it exists to replace.
 *
 * THE MATERIAL IS REAL, ALL OF IT.
 *   - The PDF on the left is `starter-packs/fsqa.json`'s `teach.sample_file`,
 *     served as a static asset, and it genuinely prints all nine things.
 *     `bin/render-setup-samples` re-reads the built PDF's text layer and fails
 *     if any requirement loses its evidence, so the document cannot drift away
 *     from the lesson.
 *   - The checklist on the right is the TENANT'S OWN `requirements` rows, read
 *     from the API. Nothing here restates the pack's copy of them; if the two
 *     ever disagree the tenant is what the portal runs on, so the tenant wins.
 *   - The decoy, its reason, and the mirror are the pack's own words. The
 *     mirror's count is read back from `/api/document-type-requirements` for
 *     the certificate-of-analysis type rather than asserted, so "closes one"
 *     is a fact about this tenant and not a sentence we wrote.
 *
 * THE CONTROL IS `DocumentFacetPicker`, WRAPPED, NOT REBUILT. It already
 * groups by checklist, searches, and — the part that is itself half the lesson
 * — offers the tenant's vocabulary and nothing else. A term that is missing is
 * added under Settings, not typed here. A lookalike built for this screen
 * would have had to relearn that, and would have drifted from the picker the
 * same person meets again on every document detail page.
 *
 * NOTHING IS PRE-TICKED, and that is deliberate even though a packed tenant
 * ALREADY has the nine rows this screen writes. The exercise is worthless if
 * the answer is on the page when it opens. What is restored on a reload is
 * what THIS PERSON ticked (`state.step4.ticked`), never the table — see
 * `readTeachState`.
 *
 * THE NUDGE IS THE TEACHING, AND IT IS NEVER A GATE. Next stays enabled
 * throughout. A first press with fewer than two boxes ticked is spent on one
 * inline sentence and a "Show me"; the intercept then disarms itself, so the
 * second press advances no matter what the screen thinks of the answer. See
 * `setNextIntercept` in stepProps.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  Fade,
  LinearProgress,
  Link,
  Paper,
  Stack,
  Typography,
  useMediaQuery,
} from '@mui/material';
import {
  AutoAwesome as ShowMeIcon,
  ExpandLess as CollapseIcon,
  ExpandMore as ExpandIcon,
  HelpOutline as WhyIcon,
  SwapHoriz as MirrorIcon,
} from '@mui/icons-material';
import PdfViewer from '../../components/PdfViewer';
import DocumentFacetPicker from '../../components/DocumentFacetPicker';
import type { FacetLinkDraftMap, FacetVocabItem } from '../../components/DocumentFacetPicker';
import { api } from '../../lib/api';
import type {
  ApiDocumentType,
  ApiRequirement,
  DocumentTypeRequirementRow,
} from '../../lib/types';
import type { SetupStepProps } from './stepProps';

/** The run-state key this screen owns. */
const TEACH_STATE_KEY = 'step4';

/**
 * Same 600ms as the shell's autosave and `records/FormBuilder.tsx`. One number
 * across the flow, so a person who has learned what "Saved" costs on one screen
 * has learned it on all of them.
 */
const WRITE_DEBOUNCE_MS = 600;

/** Gap between boxes when "Show me" ticks the pack's set. */
const STAGGER_MS = 130;

/**
 * What screen 4 records about itself.
 *
 * `ticked` is what makes a reload restore the exercise; the other three are the
 * cheapest possible answer to "did the teaching land?". If `nudge_shown` is
 * high and `nudge_accepted` is low across tenants, the nudge's copy is wrong —
 * and the fix is copy, not code, which is exactly why it is worth measuring.
 *
 * Slugs, not ids. A slug is legible in the scratch blob a year later and
 * survives a tenant being re-seeded; a row id is neither.
 */
export interface TeachStepState {
  ticked: string[];
  nudge_shown: boolean;
  nudge_accepted: boolean;
  decoy_expanded: boolean;
}

const EMPTY_TEACH_STATE: TeachStepState = {
  ticked: [],
  nudge_shown: false,
  nudge_accepted: false,
  decoy_expanded: false,
};

/**
 * Read this screen's slice of the run's scratch, defensively.
 *
 * The blob is `Record<string, unknown>` from the server and nothing validates
 * it on the way in, so every field is proved rather than cast. A malformed
 * blob restores an empty exercise, which is the same thing a first visit gets.
 */
export function readTeachState(state: Record<string, unknown> | undefined): TeachStepState {
  const raw = state?.[TEACH_STATE_KEY];
  if (!raw || typeof raw !== 'object') return EMPTY_TEACH_STATE;
  const obj = raw as Record<string, unknown>;
  return {
    ticked: Array.isArray(obj.ticked)
      ? obj.ticked.filter((s): s is string => typeof s === 'string')
      : [],
    nudge_shown: obj.nudge_shown === true,
    nudge_accepted: obj.nudge_accepted === true,
    decoy_expanded: obj.decoy_expanded === true,
  };
}

/**
 * How much of the taught document the person has found.
 *
 * Counted against the PACK'S set rather than against the tick count, so three
 * boxes that are not on this document do not read as three of nine found. The
 * remainder is stated once and never repeated — "six more" is information;
 * "six more" every two seconds is nagging.
 */
export function teachProgress(
  tickedIds: readonly string[],
  packCloseIds: readonly string[],
): { found: number; total: number; remaining: number } {
  const ticks = new Set(tickedIds);
  const found = packCloseIds.filter((id) => ticks.has(id)).length;
  return { found, total: packCloseIds.length, remaining: packCloseIds.length - found };
}

interface TeachMeta {
  nudge_shown: boolean;
  nudge_accepted: boolean;
  decoy_expanded: boolean;
}

export function StepTeach({ run, tenantId, pack, patchState, setNextIntercept }: SetupStepProps) {
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  const [requirements, setRequirements] = useState<ApiRequirement[]>([]);
  const [types, setTypes] = useState<ApiDocumentType[]>([]);
  const [mirrorRows, setMirrorRows] = useState<DocumentTypeRequirementRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [saving, setSaving] = useState(false);

  const [ticked, setTicked] = useState<string[]>([]);
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [decoyOpen, setDecoyOpen] = useState(false);
  const [pulse, setPulse] = useState(0);
  // High-water marks. Unticking a box does not retract a sentence somebody has
  // already read — a panel that vanishes when the count dips below three reads
  // as a bug, and re-earning a line you have seen is not a lesson.
  const [insightUnlocked, setInsightUnlocked] = useState(false);
  const [checklistUnlocked, setChecklistUnlocked] = useState(false);

  // The authoritative tick list, so the staggered "Show me" and the change
  // handler can both compute `next` from `prev` WITHOUT a state updater —
  // React may invoke an updater twice, and these transitions have side effects
  // (a pulse, a persist, a scheduled write) that must happen exactly once.
  const tickedRef = useRef<string[]>([]);
  const metaRef = useRef<TeachMeta>(EMPTY_TEACH_STATE);
  // Nothing is written until somebody acts. Merely opening the screen must not
  // spend the tenant's pack-seeded mapping — see `scheduleWrite`.
  const dirtyRef = useRef(false);
  const restoredRef = useRef(false);
  // The insight line fades in when it is EARNED, and appears already there on a
  // reload. Set only on the live transition, never on the restore path.
  const animateInsightRef = useRef(false);
  const nudgeSpentRef = useRef(false);
  const staggerTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const teach = pack?.teach ?? null;

  // ---- load ---------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError('');
      try {
        const [reqs, dts] = await Promise.all([
          // The tenant's whole active checklist. `limit` is the server's cap:
          // the counter says "of 32" and a page-two that never loaded would
          // make that number a lie.
          api.requirements.list({ tenant_id: tenantId, active: 1, limit: 500 }),
          api.documentTypes.list({ tenant_id: tenantId, active: 1 }),
        ]);
        if (cancelled) return;
        setRequirements(reqs.requirements);
        setTypes(dts.documentTypes);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Could not read this tenant’s requirements');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const bySlug = useMemo(
    () => new Map(requirements.map((r) => [r.slug, r] as const)),
    [requirements],
  );
  const byId = useMemo(() => new Map(requirements.map((r) => [r.id, r] as const)), [requirements]);

  const teachType = useMemo(
    () => (teach ? types.find((t) => t.slug === teach.document_type) ?? null : null),
    [teach, types],
  );
  const mirrorType = useMemo(
    () =>
      teach?.also_closed_by
        ? types.find((t) => t.slug === teach.also_closed_by?.document_type) ?? null
        : null,
    [teach, types],
  );
  const decoy = useMemo(
    () => (teach?.decoy ? bySlug.get(teach.decoy) ?? null : null),
    [teach, bySlug],
  );
  const mirrorRequirement = useMemo(
    () => (teach?.also_closed_by ? bySlug.get(teach.also_closed_by.requirement) ?? null : null),
    [teach, bySlug],
  );

  /**
   * The pack's answer, as row ids of THIS tenant.
   *
   * A slug the tenant has no row for is dropped rather than counted: the pack
   * and the tenant have then diverged, and "Show me" ticking a box that does
   * not exist is worse than ticking one fewer.
   */
  const packCloseIds = useMemo(
    () =>
      (teach?.closes ?? [])
        .map((slug) => bySlug.get(slug)?.id)
        .filter((id): id is string => typeof id === 'string'),
    [teach, bySlug],
  );

  /**
   * The mirror's count, read back rather than asserted.
   *
   * `also_closed_by` names the OTHER type that closes the decoy line item. How
   * many line items THAT type closes is a fact about this tenant's mapping, so
   * it comes from the same endpoint screen 6 uses. Failure is silent: the
   * mirror renders without a number rather than the screen erroring, because a
   * broken side panel must not take the lesson down with it.
   */
  useEffect(() => {
    if (!mirrorType) return;
    let cancelled = false;
    api.documentTypeRequirements
      .list({ documentTypeId: mirrorType.id })
      .then((res) => !cancelled && setMirrorRows(res.requirements))
      .catch(() => !cancelled && setMirrorRows(null));
    return () => {
      cancelled = true;
    };
  }, [mirrorType]);

  // ---- restore ------------------------------------------------------------

  useEffect(() => {
    if (restoredRef.current || requirements.length === 0) return;
    restoredRef.current = true;
    const saved = readTeachState(run.state);
    const ids = saved.ticked
      .map((slug) => bySlug.get(slug)?.id)
      .filter((id): id is string => typeof id === 'string');
    tickedRef.current = ids;
    metaRef.current = {
      nudge_shown: saved.nudge_shown,
      nudge_accepted: saved.nudge_accepted,
      decoy_expanded: saved.decoy_expanded,
    };
    setTicked(ids);
    setDecoyOpen(saved.decoy_expanded);
    // Restored, not earned: the sentence and the checklist are already there,
    // and neither animates.
    if (ids.length >= 2) setInsightUnlocked(true);
    if (ids.length >= 3) setChecklistUnlocked(true);
    // A nudge already spent stays spent for this run. Somebody who came back
    // the next morning is not shown the same prompt again.
    if (saved.nudge_shown) nudgeSpentRef.current = true;
  }, [requirements, run.state, bySlug]);

  // ---- persistence --------------------------------------------------------

  const persist = useCallback(
    (ticks: readonly string[], m: TeachMeta) => {
      const state: TeachStepState = {
        ticked: ticks
          .map((id) => byId.get(id)?.slug)
          .filter((slug): slug is string => typeof slug === 'string'),
        ...m,
      };
      // Debounced by the shell, so this is safe to call on every tick.
      patchState({ [TEACH_STATE_KEY]: state });
    },
    [byId, patchState],
  );

  const write = useCallback(
    async (documentTypeId: string, ids: readonly string[]) => {
      setSaving(true);
      try {
        await api.documentTypeRequirements.replace({
          documentTypeId,
          requirementIds: [...ids],
          source: 'wizard',
        });
        setWriteError('');
      } catch (err) {
        setWriteError(
          err instanceof Error ? err.message : 'Could not save what this type closes',
        );
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  /**
   * Schedule the write-through, on the shell's debounce.
   *
   * IT REFUSES TO SEND AN EMPTY SET, and the endpoint deliberately does not.
   * The PUT replaces the whole mapping, and a packed tenant arrives here with
   * nine pack-seeded rows on this type. Ticking one box and unticking it again
   * — an ordinary thing to do while reading a document — would otherwise
   * delete all nine, silently, on a screen whose entire purpose is to show what
   * a mapping is FOR. Deliberately clearing a type is a real operation; it
   * belongs on the editor that ships with the document types, not on the
   * teaching screen, where every empty set is far likelier to be somebody
   * exploring.
   */
  const scheduleWrite = useCallback(
    (ids: readonly string[]) => {
      // Cancel first, unconditionally. The early return below is a decision
      // about the CURRENT set, and a timer armed by the previous one would
      // otherwise land anyway — a tick immediately unticked would still write
      // the tick.
      if (writeTimer.current) clearTimeout(writeTimer.current);
      writeTimer.current = null;
      if (!teachType || ids.length === 0) return;
      const snapshot = [...ids];
      writeTimer.current = setTimeout(() => {
        void write(teachType.id, snapshot);
      }, WRITE_DEBOUNCE_MS);
    },
    [teachType, write],
  );

  useEffect(
    () => () => {
      if (writeTimer.current) clearTimeout(writeTimer.current);
      staggerTimers.current.forEach((t) => clearTimeout(t));
      staggerTimers.current = [];
    },
    [],
  );

  // ---- the beats ----------------------------------------------------------

  /**
   * The one place a tick change happens.
   *
   * Every beat is a consequence of `prev.length` and `next.length`, computed
   * here and nowhere else, so a beat cannot be triggered twice by two code
   * paths that both thought they owned it.
   */
  const setTicksTo = useCallback(
    (next: readonly string[]) => {
      const prev = tickedRef.current;
      const ids = [...next];
      tickedRef.current = ids;
      dirtyRef.current = true;
      setTicked(ids);

      // Beat 1 — the first tick is deliberately unrewarded. Nothing below fires
      // at a count of one.
      // Beat 2 — the second tick earns the sentence, once.
      if (ids.length >= 2 && prev.length < 2) {
        animateInsightRef.current = true;
        setInsightUnlocked(true);
      }
      // The counter animates from the second onward: continued finding is
      // acknowledged without another element appearing.
      if (ids.length > prev.length && ids.length >= 2) setPulse((p) => p + 1);
      // Beat 3 — the third redraws the supplier checklist.
      if (ids.length >= 3) setChecklistUnlocked(true);

      persist(ids, metaRef.current);
      scheduleWrite(ids);
    },
    [persist, scheduleWrite],
  );

  const setMetaTo = useCallback(
    (patch: Partial<TeachMeta>) => {
      // Ref only, no state: none of the three flags is rendered — what IS
      // rendered (the open decoy, the nudge) has its own state — and a
      // re-render mid-stagger would be a re-render for nobody.
      const next = { ...metaRef.current, ...patch };
      metaRef.current = next;
      persist(tickedRef.current, next);
    },
    [persist],
  );

  /** The picker speaks in link drafts; this screen speaks in ids. */
  const pickerValue = useMemo<FacetLinkDraftMap>(() => {
    const map: FacetLinkDraftMap = new Map();
    for (const id of ticked) map.set(id, { id, status: 'confirmed' });
    return map;
  }, [ticked]);

  const handlePickerChange = useCallback(
    (next: FacetLinkDraftMap) => {
      const nextIds = [...next.values()]
        .filter((d) => d.status !== 'rejected')
        .map((d) => d.id);
      const prev = tickedRef.current;
      // Tick ORDER is preserved so "the second box" means the second box the
      // person ticked, not the second in checklist order.
      setTicksTo([
        ...prev.filter((id) => nextIds.includes(id)),
        ...nextIds.filter((id) => !prev.includes(id)),
      ]);
    },
    [setTicksTo],
  );

  /**
   * "Show me" — tick the pack's set, one box at a time.
   *
   * The stagger is the point: nine boxes appearing at once is a state change,
   * nine boxes appearing in sequence is a document being read. Under
   * `prefers-reduced-motion` it is one step, because the same information has
   * to survive the animation being removed.
   */
  const showMe = useCallback(() => {
    staggerTimers.current.forEach((t) => clearTimeout(t));
    staggerTimers.current = [];
    setMetaTo({ nudge_accepted: true });
    setNudgeOpen(false);

    const missing = packCloseIds.filter((id) => !tickedRef.current.includes(id));
    if (missing.length === 0) return;
    if (reduceMotion) {
      setTicksTo([...tickedRef.current, ...missing]);
      return;
    }
    missing.forEach((id, i) => {
      staggerTimers.current.push(
        setTimeout(() => {
          if (tickedRef.current.includes(id)) return;
          setTicksTo([...tickedRef.current, id]);
        }, i * STAGGER_MS),
      );
    });
  }, [packCloseIds, reduceMotion, setMetaTo, setTicksTo]);

  /**
   * Beat 4's nudge, armed against the shell's Next button.
   *
   * Returns true — "this press was spent here" — at most once, and only while
   * there is something to say: fewer than two boxes, and a pack that actually
   * knows the answer. It disarms itself before returning, so the very next
   * press advances. That is the whole difference between a nudge and a gate.
   */
  useEffect(() => {
    const intercept = (): boolean => {
      if (nudgeSpentRef.current) return false;
      if (tickedRef.current.length >= 2) return false;
      if (packCloseIds.length === 0) return false;
      nudgeSpentRef.current = true;
      setNudgeOpen(true);
      setMetaTo({ nudge_shown: true });
      return true;
    };
    setNextIntercept(intercept);
    // Disarmed on unmount: React runs this cleanup before the next screen's
    // effects, so screen 5 can never inherit screen 4's claim on Next.
    return () => setNextIntercept(null);
  }, [packCloseIds, setNextIntercept, setMetaTo]);

  // ---- derived copy -------------------------------------------------------

  const vocab = useMemo<FacetVocabItem[]>(
    () =>
      requirements.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        group: r.checklist,
      })),
    [requirements],
  );

  const total = requirements.length;
  const closedCount = ticked.length;
  const openBefore = total;
  const openAfter = Math.max(total - closedCount, 0);
  const progress = teachProgress(ticked, packCloseIds);
  const mirrorCount = mirrorRows?.length ?? null;

  const sampleFile = teach?.sample_file ?? null;
  const sampleName = sampleFile?.split('/').pop() || 'sample.pdf';

  // ---- render -------------------------------------------------------------

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (loadError) {
    return <Alert severity="error">{loadError}</Alert>;
  }

  if (!teach) {
    // Not an error: a pack is allowed to ship no teaching example. Saying so
    // plainly beats an empty panel, which is indistinguishable from a bug.
    return (
      <Alert severity="info">
        <AlertTitle>This starter pack ships no teaching example</AlertTitle>
        The idea this screen exists to show — that one document closes several
        requirements at once — is configured under{' '}
        <strong>Settings ▸ Document Types</strong> for each type. Nothing here blocks the next
        screen.
      </Alert>
    );
  }

  if (!teachType) {
    return (
      <Alert severity="warning">
        <AlertTitle>
          This tenant has no <em>{teach.document_type}</em> document type
        </AlertTitle>
        The teaching example needs the pack's document types seeded. Go back to the first screen
        and apply the pack, then return — nothing here blocks the next screen either way.
      </Alert>
    );
  }

  return (
    <Box>
      <Typography variant="body1" sx={{ mb: 0.5 }}>
        This is a <strong>{teachType.name}</strong>. It is <strong>one document</strong>. You have
        {total} requirements.{' '}
        <strong>Which ones does this one file close?</strong>
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Read it on the left and tick on the right. Whatever you tick becomes what a{' '}
        {teachType.name} is proposed to close from now on, every time one arrives.
      </Typography>

      {writeError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setWriteError('')}>
          {writeError} — your ticks are still on screen, and nothing else on this tenant changed.
        </Alert>
      )}

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 1fr)' },
          alignItems: 'start',
        }}
      >
        {/* ---- left: the real document ---- */}
        <Box sx={{ height: { xs: 420, md: 680 } }}>
          {sampleFile ? (
            <PdfViewer url={sampleFile} fileName={sampleName} />
          ) : (
            <Alert severity="info" sx={{ height: '100%' }}>
              <AlertTitle>No sample document ships with this pack</AlertTitle>
              The requirements on the right are still this tenant's own, and ticking them still
              configures what a {teachType.name} closes.
            </Alert>
          )}
        </Box>

        {/* ---- right: the interaction ---- */}
        <Box>
          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Box
              sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap', mb: 0.5 }}
            >
              <Typography
                // Remounted on every increase so the pulse replays; at zero
                // duration under reduced motion the key is inert.
                key={pulse}
                variant="h6"
                fontWeight={700}
                data-testid="teach-counter"
                sx={
                  reduceMotion
                    ? undefined
                    : {
                        '@keyframes doxTeachPulse': {
                          '0%': { transform: 'scale(1)' },
                          '40%': { transform: 'scale(1.14)' },
                          '100%': { transform: 'scale(1)' },
                        },
                        animation: pulse > 0 ? 'doxTeachPulse 420ms ease-out' : 'none',
                        transformOrigin: 'left center',
                        display: 'inline-block',
                      }
                }
              >
                Closes {closedCount} of {total}
              </Typography>
              {saving && (
                <Typography variant="caption" color="text.secondary">
                  Saving…
                </Typography>
              )}
            </Box>

            <Fade
              in={insightUnlocked}
              timeout={reduceMotion || !animateInsightRef.current ? 0 : 700}
              unmountOnExit
            >
              <Box>
                <Typography variant="body2" color="primary.main" fontWeight={600}>
                  One document. Two line items. That is the idea.
                </Typography>
              </Box>
            </Fade>
          </Paper>

          {nudgeOpen && (
            <Alert
              severity="info"
              sx={{ mb: 2 }}
              data-testid="teach-nudge"
              onClose={() => setNudgeOpen(false)}
              action={
                <Button size="small" startIcon={<ShowMeIcon />} onClick={showMe}>
                  Show me
                </Button>
              }
            >
              Most people tick one here. This sheet actually closes {progress.total}.
            </Alert>
          )}

          <Paper variant="outlined" sx={{ p: 2, maxHeight: 420, overflow: 'auto' }}>
            {saving && <LinearProgress sx={{ mb: 1 }} />}
            <DocumentFacetPicker
              vocab={vocab}
              value={pickerValue}
              onChange={handlePickerChange}
              newLinkStatus="confirmed"
              searchPlaceholder="Search your requirements…"
              emptyMessage={
                <>
                  This tenant has no requirements yet. Apply a starter pack on the first
                  screen, or add them under <strong>Settings ▸ Requirements</strong>.
                </>
              }
            />
          </Paper>
        </Box>
      </Box>

      {/* ---- beat 3: the supplier checklist, redrawn ---- */}
      <Collapse in={checklistUnlocked} timeout={reduceMotion ? 0 : 400} unmountOnExit>
        <Paper variant="outlined" sx={{ p: 2, mt: 2 }} data-testid="teach-checklist">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1 }}>
            <Typography variant="subtitle2" fontWeight={700}>
              A supplier's requirements, with this one document filed
            </Typography>
            <Chip
              size="small"
              variant="outlined"
              label={`${openBefore} open → ${openAfter} open`}
              data-testid="teach-open-count"
            />
          </Box>
          <Box sx={{ maxHeight: 190, overflow: 'auto', pr: 1 }}>
            {requirements.map((r) => {
              const closed = ticked.includes(r.id);
              return (
                <Typography
                  key={r.id}
                  variant="body2"
                  sx={{
                    py: 0.15,
                    color: closed ? 'text.disabled' : 'text.primary',
                    textDecoration: closed ? 'line-through' : 'none',
                  }}
                >
                  {r.name}
                </Typography>
              );
            })}
          </Box>
          {progress.remaining > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              This sheet closes {progress.total}. You have found {progress.found}.
            </Typography>
          )}
        </Paper>
      </Collapse>

      {/* ---- beat 4: the decoy ---- */}
      {decoy && (
        <Paper variant="outlined" sx={{ mt: 2 }}>
          <Box
            component="button"
            type="button"
            onClick={() => {
              const next = !decoyOpen;
              setDecoyOpen(next);
              if (next) setMetaTo({ decoy_expanded: true });
            }}
            aria-expanded={decoyOpen}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              width: '100%',
              p: 1.5,
              border: 0,
              bgcolor: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              font: 'inherit',
              color: 'inherit',
            }}
          >
            <WhyIcon fontSize="small" color="action" />
            <Typography variant="subtitle2" fontWeight={700} sx={{ flexGrow: 1 }}>
              Why not “{decoy.name}”?
            </Typography>
            {decoyOpen ? <CollapseIcon fontSize="small" /> : <ExpandIcon fontSize="small" />}
          </Box>
          <Collapse in={decoyOpen} timeout={reduceMotion ? 0 : 300} unmountOnExit>
            <Divider />
            <Box sx={{ p: 2 }}>
              {/* The pack's own words. Restating them here would fork the
                  explanation from the file that asserts it. */}
              {teach.decoy_reason && (
                <Typography variant="body2" sx={{ mb: 1.5 }}>
                  {teach.decoy_reason}
                </Typography>
              )}
              <Typography variant="body2" fontWeight={600}>
                A {teachType.name} states <em>the product's</em> limits and measures nothing;{' '}
                {mirrorType ? `a ${mirrorType.name}` : 'a certificate of analysis'} reports{' '}
                <em>this lot's</em> results. Same numbers, different claim.
              </Typography>
              <Typography variant="body2" sx={{ mt: 1.5 }}>
                So the document's <strong>type</strong> and the line items it <strong>closes</strong>{' '}
                are different lists — which is why a {teachType.name.toLowerCase()} closes{' '}
                {progress.total}
                {mirrorCount !== null && mirrorType
                  ? ` and a ${mirrorType.name.toLowerCase()} closes ${mirrorCount}`
                  : ''}
                .
              </Typography>
            </Box>
          </Collapse>
        </Paper>
      )}

      {/* ---- beat 5: the mirror ---- */}
      {mirrorType && mirrorRequirement && (
        <Paper variant="outlined" sx={{ p: 2, mt: 2 }} data-testid="teach-mirror">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
            <MirrorIcon fontSize="small" color="action" />
            <Typography variant="subtitle2" fontWeight={700}>
              Now run it the other way
            </Typography>
          </Box>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            divider={<Divider orientation="vertical" flexItem />}
          >
            <Box sx={{ flex: 1 }}>
              <Typography variant="overline" color="text.secondary">
                One document → many line items
              </Typography>
              <Typography variant="body2">
                <strong>{teachType.name}</strong> closes <strong>{progress.total}</strong> of your{' '}
                {total} line items.
              </Typography>
            </Box>
            <Box sx={{ flex: 1 }}>
              <Typography variant="overline" color="text.secondary">
                One line item ← one document
              </Typography>
              <Typography variant="body2">
                <strong>{mirrorRequirement.name}</strong> is closed by a{' '}
                <strong>{mirrorType.name}</strong>
                {mirrorCount !== null
                  ? ` — which closes ${mirrorCount} line item${mirrorCount === 1 ? '' : 's'} in total`
                  : ''}
                , and not by the sheet on the left.
              </Typography>
            </Box>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
            The two lists are not copies of each other, and neither one is the document type. That
            mapping is what you just configured — you can change it any time under{' '}
            <Link href="/admin/document-types" underline="hover">
              Settings ▸ Document Types
            </Link>
            .
          </Typography>
        </Paper>
      )}
    </Box>
  );
}

export default StepTeach;
