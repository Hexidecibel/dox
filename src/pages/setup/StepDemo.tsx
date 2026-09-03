/**
 * Screen 6 — "Drop a document through it."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SAME DOOR AS `Import.tsx`, ON PURPOSE
 * ═══════════════════════════════════════════════════════════════════════════
 * The file goes to `POST /api/documents/process` — the exact call the Import
 * page makes, with no wizard-specific flag, no dedicated intake path and no
 * shortcut. Anything else and the demo proves the demo works. It is also why
 * nothing here approves anything: an arrival is not a document, every real
 * document is reviewed by a human, and a wizard that quietly approved its own
 * sample would teach the one lesson the pipeline most needs people not to
 * learn.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO STAGE IS SIMULATED
 * ═══════════════════════════════════════════════════════════════════════════
 * The trace is built by `buildTrace` from what the queue row actually says,
 * plus three reads against this tenant's own configuration. A stage with no
 * evidence produces no line. See `demoTrace.ts` for the rule and the reasoning;
 * the point of putting it in a separate pure module is that every failure path
 * below is assertable without a worker, a model or a browser.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FAILURE STATES ARE THE FEATURE
 * ═══════════════════════════════════════════════════════════════════════════
 * The extraction worker runs on a machine at the client's house; the model
 * behind it cold-starts with a 502, which is a named recurring failure in
 * `todo.md`, not a hypothetical. A last screen that hangs on a spinner is worse
 * than no last screen at all — it is the last thing somebody evaluating the
 * product sees, and "it just sat there" is what they will remember.
 *
 * So each failure says what happened, what to do, and whether the document
 * survived:
 *   • worker not running   → the command to start it, and a promise that this
 *                            page picks up where it left off (it keeps polling)
 *   • extraction failed    → the worker's own message, and a Retry that calls
 *                            `POST /api/queue/:id/reprocess`, the endpoint that
 *                            exists precisely to get past the retry cap
 *   • timed out            → we stop, we say we stopped, the document is still
 *                            in the review queue
 * and "Finish without the demo" is present in EVERY one of those states, and in
 * the happy one, and before a file is ever chosen.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE CLOSING ACTION, AND IT NAMES ONE SUPPLIER
 * ═══════════════════════════════════════════════════════════════════════════
 * "Apply the Baseline packet to «Darigold»". One packet, one supplier, chosen
 * by the person watching. There is deliberately no apply-to-all button here or
 * anywhere else: bulk-writing the same checklist across every supplier is what
 * made the live tenant's gap report uniform-and-wrong, and the endpoint behind
 * this cannot express it either (see `apply-packet.ts`).
 *
 * Completion is the person's DECLARATION, not a score. Finish completes the run
 * whether or not the readiness list below is green.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  CheckCircle as OkIcon,
  Description as SampleIcon,
  ErrorOutline as WarnIcon,
  InfoOutlined as InfoIcon,
  CloudUpload as UploadIcon,
  Replay as RetryIcon,
  PlaylistAddCheck as PacketIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import {
  SetupReadinessList,
  buildReadinessItems,
  loadReadinessSnapshot,
} from '../../components/SetupReadinessList';
import type { SetupReadinessSnapshot } from '../../components/SetupReadinessList';
import {
  DEMO_TIMEOUT_MS,
  buildTrace,
  classifyDemo,
  isWatching,
} from './demoTrace';
import type { DemoState, TraceLine } from './demoTrace';
import type {
  DocumentTypeRequirementRow,
  ProcessingQueueItem,
  StarterPackPacket,
} from '../../lib/types';
import type { SetupStepProps } from './stepProps';

/** How often the queue row is re-read. Fast enough to feel live, slow enough
 *  not to hammer D1 for the several minutes a cold model can take. */
const POLL_MS = 3_000;

/** Scratch keys. Read by nothing outside the wizard; see migration 0101. */
const SKIPPED_KEY = 'demo_skipped';
const QUEUE_KEY = 'demo_queue_id';

/** The one script that starts the extraction worker. Verified to exist. */
const WORKER_START_COMMAND = 'bin/process-worker-start';

interface TraceRowProps {
  line: TraceLine;
}

function TraceRow({ line }: TraceRowProps) {
  const icon =
    line.tone === 'warn' ? (
      <WarnIcon fontSize="small" color="warning" />
    ) : line.tone === 'info' ? (
      <InfoIcon fontSize="small" color="info" />
    ) : (
      <OkIcon fontSize="small" color="success" />
    );

  return (
    <Box sx={{ display: 'flex', gap: 1.25, alignItems: 'flex-start', py: 0.6 }}>
      <Box sx={{ display: 'flex', pt: '2px' }}>{icon}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" fontWeight={line.tone === 'warn' ? 700 : 500}>
          {line.text}
        </Typography>
        {line.detail && (
          <Typography variant="caption" color="text.secondary" display="block">
            {line.detail}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

/**
 * The state panel — one per `DemoState` kind that has anything to say.
 *
 * Every branch that can be acted on carries its action. `worker_silent` gets no
 * retry button on purpose: there is nothing to retry, the item has never been
 * touched, and offering a button that does nothing is how a person concludes
 * the product is broken rather than that a process is down.
 */
export interface StatePanelProps {
  state: DemoState;
  retrying: boolean;
  onRetry: () => void;
  onRestart: () => void;
}

export function StatePanel({ state, retrying, onRetry, onRestart }: StatePanelProps) {
  if (state.kind === 'upload_failed') {
    return (
      <Alert severity="error" sx={{ mt: 2 }} action={<Button onClick={onRestart}>Try again</Button>}>
        <AlertTitle>The file could not be sent</AlertTitle>
        {state.message}
      </Alert>
    );
  }

  if (state.kind === 'worker_silent') {
    return (
      <Alert severity="warning" sx={{ mt: 2 }}>
        <AlertTitle>The extraction worker is not running</AlertTitle>
        <Typography variant="body2">
          The file is safely queued — nothing has picked it up. Start the worker with{' '}
          <Box component="code" sx={{ px: 0.5, py: 0.25, bgcolor: 'action.hover', borderRadius: 0.5 }}>
            {WORKER_START_COMMAND}
          </Box>
          , then this page will pick up where it left off. Nothing needs re-uploading and this
          screen keeps watching.
        </Typography>
      </Alert>
    );
  }

  if (state.kind === 'failed') {
    return (
      <Alert
        severity="error"
        sx={{ mt: 2 }}
        action={
          <Button
            size="small"
            startIcon={retrying ? <CircularProgress size={14} /> : <RetryIcon />}
            disabled={retrying}
            onClick={onRetry}
          >
            Retry
          </Button>
        }
      >
        <AlertTitle>
          {state.coldStart ? 'Extraction failed (model cold start)' : 'Extraction failed'}
        </AlertTitle>
        <Typography variant="body2">
          {state.coldStart
            ? 'The extraction model was asleep or still loading when the worker called it. This is a known recurring failure and a retry usually succeeds once the machine is awake.'
            : 'The worker reported an error reading this document.'}
        </Typography>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.75 }}>
          {state.message}
        </Typography>
      </Alert>
    );
  }

  if (state.kind === 'timed_out') {
    return (
      <Alert
        severity="warning"
        sx={{ mt: 2 }}
        action={<Button onClick={onRestart}>Start over</Button>}
      >
        <AlertTitle>Gave up waiting after {Math.round(DEMO_TIMEOUT_MS / 60_000)} minutes</AlertTitle>
        <Typography variant="body2">
          {state.lastStatus === 'processing'
            ? 'The worker took the file and has not finished with it. That usually means the model is unusually slow or has stalled.'
            : 'Nothing ever picked the file up, so the extraction worker is almost certainly not running.'}{' '}
          The document has not been lost — it is still in the review queue, and it will appear there
          when it finishes. This screen has simply stopped watching.
        </Typography>
      </Alert>
    );
  }

  return null;
}

export function StepDemo({ run, tenantId, pack, patchState, finish }: SetupStepProps) {
  const { user } = useAuth();

  // super_admin scopes with the rail selector; everyone else is their own
  // tenant, whatever we send. `/api/documents/process` needs it explicitly.
  const effectiveTenantId = tenantId ?? user?.tenant_id ?? '';

  const [item, setItem] = useState<ProcessingQueueItem | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [retrying, setRetrying] = useState(false);
  const [sampleMissing, setSampleMissing] = useState(false);

  // The three tenant reads the trace needs beyond the queue row. Each is
  // independent and each starts null — null means NOT READ and produces no
  // line, which is what keeps a failed side read from inventing a stage.
  const [typeRequirements, setTypeRequirements] = useState<DocumentTypeRequirementRow[] | null>(null);
  const [hasTypeInstructions, setHasTypeInstructions] = useState<boolean | null>(null);
  const [renewalOwner, setRenewalOwner] = useState<{ label: string; recipients: string[] } | null>(null);

  const [snapshot, setSnapshot] = useState<SetupReadinessSnapshot | null>(null);

  const [packetSlug, setPacketSlug] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [applied, setApplied] = useState<{
    packet: string;
    supplier: string;
    required: number;
    recommended: number;
    unknown: string[];
    created: boolean;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const elapsedMs = startedAt === null ? 0 : now - startedAt;
  const state = useMemo(
    () => classifyDemo({ item, elapsedMs, uploadError, uploading }),
    [item, elapsedMs, uploadError, uploading],
  );

  const packets: StarterPackPacket[] = useMemo(() => pack?.packets ?? [], [pack]);
  const sampleFile = pack?.teach?.sample_file ?? null;

  // ---- polling ------------------------------------------------------------

  /**
   * One row, read from `/api/queue/:id`.
   *
   * The single-row read rather than the list: it carries the same server-side
   * annotations (`spec_results`, `renewal_proposal`, the joined type name) and
   * does not scan a queue that may hold hundreds of other tenants' work. The
   * clock is advanced in the same tick as the row so the elapsed-time states
   * cannot lag a poll behind what they are describing.
   */
  const poll = useCallback(async (queueId: string) => {
    try {
      const res = await api.queue.get(queueId);
      setItem(res.item);
    } catch {
      // A failed poll is not a failed extraction. Leaving the last-known row in
      // place means a blip shows as "still working" rather than as a state
      // change nothing actually made.
    } finally {
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    if (!item || !isWatching(state)) return;
    const id = setInterval(() => void poll(item.id), POLL_MS);
    return () => clearInterval(id);
  }, [item, state, poll]);

  /**
   * Resume the row this run already dropped, on a reload.
   *
   * The whole reason `tenant_setup_runs` exists is that somebody interrupted on
   * screen 4 must not start over; the last screen would be the one place that
   * still did. The clock restarts from `created_at` rather than from now, so a
   * page reopened an hour after an abandoned upload lands on `timed_out` — the
   * honest answer — instead of pretending the wait has just begun.
   *
   * Runs once, on mount. A resumed row that has since gone `ready` simply shows
   * its finished trace, which is exactly what somebody coming back wants.
   */
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    const queueId = run.state[QUEUE_KEY];
    if (typeof queueId !== 'string' || queueId.length === 0) return;
    resumedRef.current = true;
    void (async () => {
      try {
        const res = await api.queue.get(queueId);
        const created = Date.parse(res.item.created_at);
        setItem(res.item);
        setStartedAt(Number.isFinite(created) ? created : Date.now());
        setNow(Date.now());
      } catch {
        // The row is gone (rejected and swept, or another tenant's). Fall back
        // to the empty drop zone rather than to an error: there is nothing
        // broken here, there is just nothing to resume.
      }
    })();
  }, [run.state]);

  // The clock has to move on its own too: `worker_silent` and `timed_out` are
  // reached by TIME PASSING, not by the row changing, so a screen that only
  // re-rendered on a poll response would never announce a worker that has
  // stopped responding at all.
  useEffect(() => {
    if (startedAt === null || !isWatching(state)) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [startedAt, state]);

  // ---- the side reads -----------------------------------------------------

  const documentTypeId = item?.document_type_id ?? null;

  useEffect(() => {
    if (!documentTypeId) return;
    let cancelled = false;

    void api.documentTypeRequirements
      .list({ documentTypeId })
      .then((res) => !cancelled && setTypeRequirements(res.requirements))
      // Left null. A read that failed must not be reported as "closes nothing",
      // which is a real and different answer.
      .catch(() => undefined);

    void api.documentTypeInstructions
      .get({ document_type_id: documentTypeId, tenant_id: tenantId })
      .then((res) => !cancelled && setHasTypeInstructions(Boolean(res.instructions?.trim())))
      .catch(() => undefined);

    // The renewal owner is two reads: the type's `default_owner` label, and
    // whether `owner_routes` resolves it to anybody. Both are needed because
    // "QA owns this" and "QA reaches nobody" are the two halves of the only
    // sentence worth printing.
    void (async () => {
      try {
        const types = await api.documentTypes.list({ tenant_id: tenantId, active: 1 });
        const type = types.documentTypes.find((t) => t.id === documentTypeId);
        const label = type?.default_owner?.trim() || null;
        if (!label || cancelled) return;
        const routes = await api.ownerRoutes.list({ tenantId, owner: label });
        if (cancelled) return;
        setRenewalOwner({
          label,
          // Deactivated routes are excluded: a route somebody switched off is
          // not somebody who will be emailed, and counting it would turn a
          // routing gap into a green line.
          recipients: routes.routes
            .filter((r) => r.active !== 0)
            .map((r) => r.email ?? r.user_email ?? r.user_name ?? '')
            .filter(Boolean),
        });
      } catch {
        // Same rule: no read, no line.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [documentTypeId, tenantId]);

  // The readiness list, refreshed whenever the demo reaches a resting state so
  // "1 supplier" appears after a packet is applied without a manual reload.
  const reloadSnapshot = useCallback(async () => {
    try {
      setSnapshot(await loadReadinessSnapshot(tenantId));
    } catch {
      // The list renders whatever it has; a failed read leaves it as it was.
    }
  }, [tenantId]);

  useEffect(() => {
    void reloadSnapshot();
  }, [reloadSnapshot]);

  // ---- the upload ---------------------------------------------------------

  const startUpload = useCallback(
    async (file: File) => {
      if (!effectiveTenantId) {
        setUploadError('No tenant is selected. Pick one in the sidebar first.');
        return;
      }
      setUploadError(null);
      setUploading(true);
      setItem(null);
      setTypeRequirements(null);
      setHasTypeInstructions(null);
      setRenewalOwner(null);
      try {
        // No `document_type_id`: letting the classifier decide is the point.
        // Telling the pipeline what the document is would skip the first line
        // of the trace and make the rest of it less true.
        const res = await api.processing.process([file], effectiveTenantId);
        const queued = res.items.find((i) => i.id);
        if (!queued?.id) {
          throw new Error('The file was accepted but no queue item came back.');
        }
        setStartedAt(Date.now());
        setNow(Date.now());
        // Recorded so a reload can find the row again. Bookkeeping only —
        // nothing outside this screen reads it.
        patchState({ [QUEUE_KEY]: queued.id, [SKIPPED_KEY]: false });
        await poll(queued.id);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Upload failed');
      } finally {
        setUploading(false);
      }
    },
    [effectiveTenantId, patchState, poll],
  );

  /**
   * The bundled sample, fetched from wherever the PACK says it lives.
   *
   * The path is read at runtime and is allowed to be null (no sample ships with
   * this pack) or to 404 (the file was named but never produced). Both fall
   * back to "drop your own file", which is the honest state and is why the drop
   * zone is never hidden behind the sample button.
   */
  const useSample = useCallback(async () => {
    if (!sampleFile) return;
    setUploadError(null);
    setSampleMissing(false);
    try {
      const res = await fetch(sampleFile);
      if (!res.ok) {
        setSampleMissing(true);
        return;
      }
      const blob = await res.blob();
      const name = sampleFile.split('/').pop() || 'sample.pdf';
      await startUpload(new File([blob], name, { type: blob.type || 'application/pdf' }));
    } catch {
      setSampleMissing(true);
    }
  }, [sampleFile, startUpload]);

  const retry = useCallback(async () => {
    if (!item) return;
    setRetrying(true);
    try {
      // The endpoint that zeroes `attempts` past the worker's own retry cap —
      // which is exactly the state a cold-start 502 leaves an item in.
      await api.queue.reprocess(item.id);
      setStartedAt(Date.now());
      setNow(Date.now());
      await poll(item.id);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not retry');
    } finally {
      setRetrying(false);
    }
  }, [item, poll]);

  const restart = useCallback(() => {
    setItem(null);
    setStartedAt(null);
    setUploadError(null);
    setSampleMissing(false);
    setTypeRequirements(null);
    setHasTypeInstructions(null);
    setRenewalOwner(null);
    // The remembered row goes too. Somebody who gave up on a stuck extraction
    // and reloaded the page should get the drop zone back, not the same stalled
    // item resumed straight into `timed_out`.
    patchState({ [QUEUE_KEY]: null });
  }, [patchState]);

  // ---- the closing action -------------------------------------------------

  // Pre-filled from the document, editable, and never applied on its own. The
  // extraction is a proposal about who sent this; the person watching is the
  // one who decides which supplier a checklist gets attached to.
  // Prefilled ONCE per extracted name. Keyed on the name rather than guarded by
  // "the field is empty", because a person who deliberately clears the box is
  // making an edit and a field that refills itself is a field fighting them.
  const prefilledFor = useRef<string | null>(null);
  useEffect(() => {
    const extracted = item?.supplier ?? null;
    if (!extracted || prefilledFor.current === extracted) return;
    prefilledFor.current = extracted;
    setSupplierName(extracted);
  }, [item?.supplier]);

  useEffect(() => {
    if (packetSlug || packets.length === 0) return;
    setPacketSlug((packets.find((p) => p.default) ?? packets[0]).slug);
  }, [packets, packetSlug]);

  const selectedPacket = packets.find((p) => p.slug === packetSlug) ?? null;

  const applyPacket = useCallback(async () => {
    if (!pack || !selectedPacket || !supplierName.trim()) return;
    setApplying(true);
    setApplyError('');
    try {
      const res = await api.starterPacks.applyPacket({
        pack: pack.pack,
        packet: selectedPacket.slug,
        supplierName: supplierName.trim(),
        tenantId,
      });
      setApplied({
        packet: res.packet_name,
        supplier: res.supplier_name,
        required: res.attached.required,
        recommended: res.attached.recommended,
        unknown: res.unknown_requirements,
        created: res.supplier_created,
      });
      await reloadSnapshot();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'Could not apply the packet');
    } finally {
      setApplying(false);
    }
  }, [pack, selectedPacket, supplierName, tenantId, reloadSnapshot]);

  // ---- render -------------------------------------------------------------

  const trace = useMemo(
    () => buildTrace({ item, typeRequirements, hasTypeInstructions, renewalOwner }),
    [item, typeRequirements, hasTypeInstructions, renewalOwner],
  );

  const watching = isWatching(state);

  return (
    <Box>
      <Typography variant="body1" sx={{ mb: 2 }}>
        This is the real pipeline, not a preview. The file goes through the same door the Import
        page uses, and everything below is read back out of the queue as it happens — nothing here
        is a canned animation. <strong>Nothing is approved</strong>: the document lands in the
        review queue for a person, which is how every document arrives.
      </Typography>

      {/* ---------------------------------------------------- the file itself */}
      {item === null && !uploading && (
        <Paper variant="outlined" sx={{ p: 3, textAlign: 'center', mb: 2 }}>
          <UploadIcon color="disabled" sx={{ fontSize: 40 }} />
          <Typography variant="body1" fontWeight={600} sx={{ mt: 1 }}>
            Drop a document in
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            A certificate, a specification sheet, an insurance certificate — anything a supplier has
            actually sent you reads better than a sample.
          </Typography>
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void startUpload(file);
              e.target.value = '';
            }}
          />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent="center">
            <Button variant="contained" onClick={() => fileInputRef.current?.click()}>
              Choose a file
            </Button>
            {sampleFile && (
              <Button variant="outlined" startIcon={<SampleIcon />} onClick={() => void useSample()}>
                Use the {pack?.label ?? 'pack'} sample
              </Button>
            )}
          </Stack>
          {!sampleFile && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5 }}>
              This pack ships no sample document, so there is nothing to fall back on — use one of
              your own.
            </Typography>
          )}
          {sampleMissing && (
            <Alert severity="warning" sx={{ mt: 2, textAlign: 'left' }}>
              The sample document this pack names could not be fetched. Use one of your own files
              instead — the demo is the same either way.
            </Alert>
          )}
        </Paper>
      )}

      {(uploading || watching) && <LinearProgress sx={{ mb: 2 }} />}

      {/* ---------------------------------------------------------- the trace */}
      {trace.length > 0 && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={700}>
              What happened to it
            </Typography>
            {watching && <Chip size="small" label="live" color="primary" variant="outlined" />}
          </Box>
          <Divider sx={{ mb: 0.5 }} />
          {trace.map((line) => (
            <TraceRow key={line.key} line={line} />
          ))}
          {watching && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
              {state.kind === 'extracting'
                ? 'Reading the document…'
                : 'Waiting for the extraction worker to pick it up…'}
            </Typography>
          )}
        </Paper>
      )}

      <StatePanel state={state} retrying={retrying} onRetry={() => void retry()} onRestart={restart} />

      {state.kind === 'ready' && (
        <Alert severity="success" sx={{ mt: 2 }}>
          <AlertTitle>It is in the review queue</AlertTitle>
          Nothing has been approved and no document row exists yet. A person confirms what the
          extraction found, and the checklist items above are proposed at that moment.
        </Alert>
      )}

      {/* ------------------------------------------------- the closing action */}
      <Divider sx={{ my: 3 }} />

      <Typography variant="h6" fontWeight={700} gutterBottom>
        Give one supplier a checklist
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        A packet is a starting point for <strong>one</strong> supplier — never a rule applied to all
        of them. Seeding every supplier the same items is how a checklist ends up uniform and wrong,
        so there is no button here that does it. You will apply one to each supplier as they arrive,
        and edit it afterwards.
      </Typography>

      {packets.length === 0 ? (
        <Alert severity="info">
          This pack defines no packets, so there is nothing to apply. Supplier checklists are built
          on the Supplier Requirements screen.
        </Alert>
      ) : applied ? (
        <Alert severity="success">
          <AlertTitle>
            {applied.packet} applied to {applied.supplier}
            {applied.created ? ' (created)' : ''}
          </AlertTitle>
          {applied.required + applied.recommended === 0 ? (
            <>
              Every line item in this packet was already on {applied.supplier}, so nothing changed.
              Re-applying a packet never overwrites what somebody edited.
            </>
          ) : (
            <>
              {applied.required} required and {applied.recommended} recommended line item
              {applied.required + applied.recommended === 1 ? '' : 's'} now apply to{' '}
              {applied.supplier}. Every row records which packet it came from, so a wrong default is
              findable later.
            </>
          )}
          {applied.unknown.length > 0 && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              {applied.unknown.length} item{applied.unknown.length === 1 ? '' : 's'} in the packet
              have no checklist row in this tenant and were skipped:{' '}
              {applied.unknown.join(', ')}. Re-run the starter pack on the first screen to add them.
            </Typography>
          )}
        </Alert>
      ) : (
        <Paper variant="outlined" sx={{ p: 2 }}>
          {applyError && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setApplyError('')}>
              {applyError}
            </Alert>
          )}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="flex-start">
            <FormControl size="small" sx={{ minWidth: 220 }}>
              <InputLabel id="setup-packet-label">Packet</InputLabel>
              <Select
                labelId="setup-packet-label"
                label="Packet"
                value={packetSlug}
                onChange={(e) => setPacketSlug(e.target.value)}
              >
                {packets.map((p) => (
                  <MenuItem key={p.slug} value={p.slug}>
                    {p.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              size="small"
              label="Supplier"
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
              helperText={
                item?.supplier
                  ? 'Read off the document you just dropped. Change it if it read the name wrong.'
                  : 'Name the supplier this checklist belongs to.'
              }
              sx={{ minWidth: 260 }}
            />
            <Button
              variant="contained"
              startIcon={applying ? <CircularProgress size={16} color="inherit" /> : <PacketIcon />}
              disabled={applying || !selectedPacket || supplierName.trim().length === 0}
              onClick={() => void applyPacket()}
            >
              {selectedPacket && supplierName.trim()
                ? `Apply the ${selectedPacket.name} packet to ${supplierName.trim()}`
                : 'Apply the packet'}
            </Button>
          </Stack>
          {selectedPacket && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5 }}>
              {selectedPacket.description
                ? `${selectedPacket.description} `
                : ''}
              {selectedPacket.requirements.length} required, {selectedPacket.recommends.length}{' '}
              recommended. The supplier is created if it does not exist yet.
            </Typography>
          )}
        </Paper>
      )}

      {/* ------------------------------------------------------- the readiness */}
      <Divider sx={{ my: 3 }} />

      <Typography variant="h6" fontWeight={700} gutterBottom>
        Where this tenant stands
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        None of this blocks finishing. A tenant with amber rows still accepts documents, reads them
        and puts them in front of a reviewer — the list is about how much the system will have to
        say when it does.
      </Typography>
      {snapshot ? (
        <SetupReadinessList items={buildReadinessItems(snapshot)} />
      ) : (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      )}

      {/* ---------------------------------------------------------- finishing */}
      <Divider sx={{ my: 3 }} />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems="center">
        <Button variant="contained" onClick={() => void finish()}>
          Finish setup
        </Button>
        {/*
          ALWAYS PRESENT. Not conditional on a failure, because the point of the
          escape hatch is that somebody can take it before they know whether the
          demo is going to work — a way out that only appears once you are stuck
          has already failed the person who needed it.
        */}
        <Button onClick={() => void finish({ [SKIPPED_KEY]: true })}>
          Finish without the demo
        </Button>
        <Typography variant="caption" color="text.secondary">
          Finishing is your call, not a score. The run is marked complete whether or not the list
          above is green.
        </Typography>
      </Stack>
    </Box>
  );
}

export default StepDemo;
