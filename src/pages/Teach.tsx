import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box,
  Paper,
  Typography,
  Button,
  TextField,
  CircularProgress,
  Alert,
  Avatar,
  Chip,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  Tooltip,
} from '@mui/material';
import {
  AutoAwesome as AiIcon,
  Person as SmeIcon,
  Send as SendIcon,
  School as TeachIcon,
  CheckCircle as CheckCircleIcon,
  ArrowBack as BackIcon,
  Add as AddIcon,
  Delete as DeleteIcon,
  Lightbulb as IssueIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useTenant } from '../contexts/TenantContext';
import SupplierAutocomplete, { type SupplierValue } from '../components/SupplierAutocomplete';
import type {
  TeachMessage,
  TeachProposal,
  TeachExample,
  ApiDocumentType,
} from '../lib/types';

// Mirror of functions/lib/teach/uncertainty.ts — the analyzer's detected
// ambiguities, shown to the SME as context for what the AI is unsure about.
interface UncertaintyIssue {
  id: string;
  field: string;
  kind: 'often-empty' | 'inconsistent' | 'implausible' | 'low-confidence';
  summary: string;
  severity: number;
  examples: Array<{ queue_item_id: string; file_name: string | null; value: string | null }>;
}

type Phase = 'setup' | 'chat' | 'proposal' | 'done';

/**
 * Learning Interface — a conversational teach-chat where a domain expert
 * teaches the system how to read a supplier's documents.
 *
 * Flow: setup (pick supplier + doctype) -> chat (answer the AI's questions in
 * prose) -> proposal (review/edit the synthesized guidance) -> confirm (write
 * the (supplier, doctype) extraction profile).
 */
export default function Teach() {
  const { sessionId: routeSessionId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();

  // For non-super-admins the tenant is their own; super_admins use the
  // global tenant selector (falling back to their own if set).
  const tenantId = isSuperAdmin ? selectedTenantId || undefined : user?.tenant_id || undefined;

  const [phase, setPhase] = useState<Phase>(routeSessionId ? 'chat' : 'setup');
  const [error, setError] = useState<string | null>(null);

  // ---- Setup state -------------------------------------------------------
  const [supplier, setSupplier] = useState<SupplierValue>({ supplierName: '', verified: false });
  const [docTypes, setDocTypes] = useState<ApiDocumentType[]>([]);
  const [docTypeId, setDocTypeId] = useState('');
  const [docTypesLoading, setDocTypesLoading] = useState(false);
  const [starting, setStarting] = useState(false);

  // ---- Chat state --------------------------------------------------------
  const [sessionId, setSessionId] = useState<string | null>(routeSessionId || null);
  const [messages, setMessages] = useState<TeachMessage[]>([]);
  const [issues, setIssues] = useState<UncertaintyIssue[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [readyToSynthesize, setReadyToSynthesize] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);

  // ---- Proposal state ----------------------------------------------------
  const [synthesizing, setSynthesizing] = useState(false);
  const [proposal, setProposal] = useState<TeachProposal | null>(null);
  const [editInstructions, setEditInstructions] = useState('');
  const [editExamples, setEditExamples] = useState<TeachExample[]>([]);
  const [confirming, setConfirming] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Friendly labels for the success message.
  const [supplierLabel, setSupplierLabel] = useState('');
  const [docTypeLabel, setDocTypeLabel] = useState('');

  // -----------------------------------------------------------------------
  // Setup: load supplier-scoped doctypes whenever a verified supplier is set.
  // -----------------------------------------------------------------------
  const supplierId = supplier.supplierId;
  useEffect(() => {
    if (phase !== 'setup' || !supplierId) {
      setDocTypes([]);
      return;
    }
    let cancelled = false;
    setDocTypesLoading(true);
    api.documentTypes
      .list({ tenant_id: tenantId, supplier_id: supplierId, active: 1 })
      .then((res) => {
        if (cancelled) return;
        setDocTypes(res.documentTypes || []);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load document types');
        setDocTypes([]);
      })
      .finally(() => {
        if (!cancelled) setDocTypesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [phase, supplierId, tenantId]);

  // -----------------------------------------------------------------------
  // Resume: load an existing session from the URL.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!routeSessionId) return;
    let cancelled = false;
    setLoadingSession(true);
    api.teach
      .getSession(routeSessionId, tenantId)
      .then((res) => {
        if (cancelled) return;
        setSessionId(res.session.id);
        setMessages(res.messages || []);
        setIssues((res.issues || []) as UncertaintyIssue[]);
        if (res.proposal) {
          setProposal(res.proposal);
          setEditInstructions(res.proposal.instructions);
          setEditExamples(res.proposal.examples);
        }
        if (res.session.status === 'confirmed') {
          setPhase('done');
        } else if (res.session.status === 'synthesized' && res.proposal) {
          setPhase('proposal');
        } else {
          setReadyToSynthesize(true); // resumed open session: let them synthesize
          setPhase('chat');
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load this teaching session');
      })
      .finally(() => {
        if (!cancelled) setLoadingSession(false);
      });
    return () => {
      cancelled = true;
    };
  }, [routeSessionId, tenantId]);

  // -----------------------------------------------------------------------
  // Deep-link prefill: ?supplier_id=&document_type_id= from SupplierDetail.
  // -----------------------------------------------------------------------
  const prefillSupplierId = searchParams.get('supplier_id');
  const prefillDocTypeId = searchParams.get('document_type_id');
  useEffect(() => {
    if (routeSessionId || !prefillSupplierId) return;
    let cancelled = false;
    api.suppliers
      .get(prefillSupplierId)
      .then((res) => {
        if (cancelled) return;
        setSupplier({ supplierId: res.supplier.id, supplierName: res.supplier.name, verified: true });
        if (prefillDocTypeId) setDocTypeId(prefillDocTypeId);
      })
      .catch(() => {
        /* fall back to manual setup */
      });
    return () => {
      cancelled = true;
    };
  }, [routeSessionId, prefillSupplierId, prefillDocTypeId]);

  // Auto-scroll the transcript on new messages.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending, synthesizing]);

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------
  const handleStart = useCallback(async () => {
    if (!supplier.supplierId || !docTypeId) return;
    setStarting(true);
    setError(null);
    try {
      const res = await api.teach.createSession({
        supplier_id: supplier.supplierId,
        document_type_id: docTypeId,
        tenant_id: tenantId,
      });
      setSessionId(res.session_id);
      setMessages(res.messages || []);
      setIssues((res.issues || []) as UncertaintyIssue[]);
      setSupplierLabel(supplier.supplierName);
      setDocTypeLabel(docTypes.find((d) => d.id === docTypeId)?.name || '');
      setReadyToSynthesize(false);
      setPhase('chat');
      // Reflect the session in the URL so a refresh resumes it.
      navigate(`/teach/${res.session_id}`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the teaching session');
    } finally {
      setStarting(false);
    }
  }, [supplier, docTypeId, docTypes, tenantId, navigate]);

  const handleSend = useCallback(async () => {
    const content = draft.trim();
    if (!content || !sessionId) return;
    setSending(true);
    setError(null);
    // Optimistic SME bubble.
    const optimistic: TeachMessage = {
      id: `local-${Date.now()}`,
      session_id: sessionId,
      role: 'sme',
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);
    setDraft('');
    try {
      const res = await api.teach.postMessage(sessionId, content, tenantId);
      setMessages(res.messages || []);
      setReadyToSynthesize(res.ready_to_synthesize);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send your answer');
      // Roll back the optimistic bubble so the thread reflects the server.
      setMessages((m) => m.filter((msg) => msg.id !== optimistic.id));
      setDraft(content);
    } finally {
      setSending(false);
    }
  }, [draft, sessionId, tenantId]);

  const handleSynthesize = useCallback(async () => {
    if (!sessionId) return;
    setSynthesizing(true);
    setError(null);
    try {
      const res = await api.teach.synthesize(sessionId, tenantId);
      setProposal(res.proposal);
      setEditInstructions(res.proposal.instructions);
      setEditExamples(res.proposal.examples);
      setPhase('proposal');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not summarize what was learned');
    } finally {
      setSynthesizing(false);
    }
  }, [sessionId, tenantId]);

  const handleConfirm = useCallback(async () => {
    if (!sessionId) return;
    setConfirming(true);
    setError(null);
    try {
      await api.teach.confirm(sessionId, {
        instructions: editInstructions,
        examples: editExamples,
        tenant_id: tenantId,
      });
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the profile');
    } finally {
      setConfirming(false);
    }
  }, [sessionId, editInstructions, editExamples, tenantId]);

  // Example editing helpers (proposal phase).
  const updateExample = (idx: number, patch: Partial<TeachExample>) =>
    setEditExamples((ex) => ex.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  const removeExample = (idx: number) =>
    setEditExamples((ex) => ex.filter((_, i) => i !== idx));
  const addExample = () =>
    setEditExamples((ex) => [...ex, { field: '', value: '', note: '' }]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto', display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
        <TeachIcon color="primary" sx={{ fontSize: 32 }} />
        <Box>
          <Typography variant="h5" fontWeight={700}>
            Teach the AI
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Have a conversation to show the system how to read a supplier's documents.
          </Typography>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {loadingSession ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : phase === 'setup' ? (
        <SetupView
          tenantId={tenantId}
          supplier={supplier}
          onSupplierChange={setSupplier}
          docTypes={docTypes}
          docTypesLoading={docTypesLoading}
          docTypeId={docTypeId}
          onDocTypeChange={setDocTypeId}
          starting={starting}
          onStart={handleStart}
        />
      ) : phase === 'proposal' && proposal ? (
        <ProposalView
          summary={proposal.summary}
          instructions={editInstructions}
          onInstructionsChange={setEditInstructions}
          examples={editExamples}
          onUpdateExample={updateExample}
          onRemoveExample={removeExample}
          onAddExample={addExample}
          confirming={confirming}
          onConfirm={handleConfirm}
          onBack={() => setPhase('chat')}
        />
      ) : phase === 'done' ? (
        <DoneView
          supplierLabel={supplierLabel}
          docTypeLabel={docTypeLabel}
          onTeachAnother={() => {
            setPhase('setup');
            setSessionId(null);
            setMessages([]);
            setIssues([]);
            setProposal(null);
            setSupplier({ supplierName: '', verified: false });
            setDocTypeId('');
            setReadyToSynthesize(false);
            navigate('/teach', { replace: true });
          }}
        />
      ) : (
        <ChatView
          scrollRef={scrollRef}
          messages={messages}
          issues={issues}
          draft={draft}
          onDraftChange={setDraft}
          sending={sending}
          onSend={handleSend}
          readyToSynthesize={readyToSynthesize}
          synthesizing={synthesizing}
          onSynthesize={handleSynthesize}
        />
      )}
    </Box>
  );
}

// ===========================================================================
// Setup
// ===========================================================================
function SetupView({
  tenantId,
  supplier,
  onSupplierChange,
  docTypes,
  docTypesLoading,
  docTypeId,
  onDocTypeChange,
  starting,
  onStart,
}: {
  tenantId?: string;
  supplier: SupplierValue;
  onSupplierChange: (v: SupplierValue) => void;
  docTypes: ApiDocumentType[];
  docTypesLoading: boolean;
  docTypeId: string;
  onDocTypeChange: (id: string) => void;
  starting: boolean;
  onStart: () => void;
}) {
  const canStart = !!supplier.supplierId && !!docTypeId && !starting;
  return (
    <Paper variant="outlined" sx={{ p: 4, maxWidth: 560, mx: 'auto', width: '100%' }}>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 0.5 }}>
        Which documents do you want to teach me about?
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Pick the supplier and the kind of document. I'll ask you a few questions about how to
        read them, and from your answers I'll learn to do it on my own.
      </Typography>

      <Stack spacing={3}>
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Supplier
          </Typography>
          <SupplierAutocomplete
            tenantId={tenantId || ''}
            value={supplier}
            onChange={onSupplierChange}
            label="Supplier"
            size="medium"
          />
        </Box>

        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Document type
          </Typography>
          <TextField
            select
            fullWidth
            size="medium"
            value={docTypeId}
            onChange={(e) => onDocTypeChange(e.target.value)}
            disabled={!supplier.supplierId || docTypesLoading}
            helperText={
              !supplier.supplierId
                ? 'Choose a supplier first'
                : docTypesLoading
                  ? 'Loading document types…'
                  : docTypes.length === 0
                    ? 'No document types found for this supplier'
                    : 'Which kind of document do these come in as?'
            }
          >
            {docTypes.map((dt) => (
              <MenuItem key={dt.id} value={dt.id}>
                {dt.name}
              </MenuItem>
            ))}
          </TextField>
        </Box>

        <Button
          variant="contained"
          size="large"
          startIcon={starting ? <CircularProgress size={18} color="inherit" /> : <TeachIcon />}
          disabled={!canStart}
          onClick={onStart}
        >
          {starting ? 'Starting…' : 'Start teaching'}
        </Button>
      </Stack>
    </Paper>
  );
}

// ===========================================================================
// Chat
// ===========================================================================
function ChatView({
  scrollRef,
  messages,
  issues,
  draft,
  onDraftChange,
  sending,
  onSend,
  readyToSynthesize,
  synthesizing,
  onSynthesize,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  messages: TeachMessage[];
  issues: UncertaintyIssue[];
  draft: string;
  onDraftChange: (v: string) => void;
  sending: boolean;
  onSend: () => void;
  readyToSynthesize: boolean;
  synthesizing: boolean;
  onSynthesize: () => void;
}) {
  return (
    <Box sx={{ display: 'flex', gap: 2, flex: 1, minHeight: 0 }}>
      {/* Conversation column */}
      <Paper
        variant="outlined"
        sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, height: '70vh' }}
      >
        <Box ref={scrollRef} sx={{ flex: 1, overflowY: 'auto', p: 3 }}>
          <Stack spacing={2}>
            {messages
              .filter((m) => m.role !== 'system')
              .map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
            {(sending || synthesizing) && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 1 }}>
                <Avatar sx={{ bgcolor: 'primary.main', width: 32, height: 32 }}>
                  <AiIcon fontSize="small" />
                </Avatar>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <CircularProgress size={16} />
                  <Typography variant="body2" color="text.secondary">
                    {synthesizing ? 'Summarizing what I learned…' : 'Thinking…'}
                  </Typography>
                </Box>
              </Box>
            )}
          </Stack>
        </Box>

        <Divider />

        {readyToSynthesize && (
          <Box sx={{ px: 3, pt: 2 }}>
            <Alert
              severity="success"
              action={
                <Button
                  color="inherit"
                  size="small"
                  variant="outlined"
                  disabled={synthesizing}
                  onClick={onSynthesize}
                >
                  Review what I learned
                </Button>
              }
            >
              I think I understand enough. Review the summary, or keep teaching me below.
            </Alert>
          </Box>
        )}

        {/* Composer */}
        <Box sx={{ p: 2, display: 'flex', gap: 1, alignItems: 'flex-end' }}>
          <TextField
            fullWidth
            multiline
            maxRows={6}
            placeholder="Type your answer…"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            disabled={sending}
          />
          <Tooltip title="Send (Enter)">
            <span>
              <IconButton
                color="primary"
                onClick={onSend}
                disabled={sending || !draft.trim()}
                sx={{ mb: 0.5 }}
              >
                <SendIcon />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Paper>

      {/* Issues / grounding side panel */}
      {issues.length > 0 && (
        <Paper
          variant="outlined"
          sx={{ width: 300, flexShrink: 0, p: 2, overflowY: 'auto', height: '70vh', display: { xs: 'none', md: 'block' } }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
            <IssueIcon color="warning" fontSize="small" />
            <Typography variant="subtitle2" fontWeight={600}>
              What I'm unsure about
            </Typography>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
            These are things in past documents that confused me. Your answers help clear them up.
          </Typography>
          <Stack spacing={1.5}>
            {issues.map((issue) => (
              <Box key={issue.id}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
                  <Chip label={issue.field} size="small" color="default" />
                  <Chip label={issue.kind.replace('-', ' ')} size="small" variant="outlined" />
                </Box>
                <Typography variant="body2" sx={{ mt: 0.5 }}>
                  {issue.summary}
                </Typography>
                {issue.examples.length > 0 && (
                  <Box sx={{ mt: 0.5 }}>
                    {issue.examples.slice(0, 3).map((ex, i) => (
                      <Typography
                        key={i}
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', fontFamily: 'monospace' }}
                      >
                        {ex.file_name ? `${ex.file_name}: ` : ''}
                        {ex.value ?? '(empty)'}
                      </Typography>
                    ))}
                  </Box>
                )}
                <Divider sx={{ mt: 1.5 }} />
              </Box>
            ))}
          </Stack>
        </Paper>
      )}
    </Box>
  );
}

function MessageBubble({ message }: { message: TeachMessage }) {
  const isAi = message.role === 'ai';
  return (
    <Box sx={{ display: 'flex', flexDirection: isAi ? 'row' : 'row-reverse', gap: 1.5 }}>
      <Avatar
        sx={{
          bgcolor: isAi ? 'primary.main' : 'grey.400',
          width: 32,
          height: 32,
          flexShrink: 0,
        }}
      >
        {isAi ? <AiIcon fontSize="small" /> : <SmeIcon fontSize="small" />}
      </Avatar>
      <Paper
        elevation={0}
        sx={{
          p: 1.5,
          maxWidth: '78%',
          bgcolor: isAi ? 'action.hover' : 'primary.main',
          color: isAi ? 'text.primary' : 'primary.contrastText',
          borderRadius: 2,
        }}
      >
        <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap' }}>
          {message.content}
        </Typography>
      </Paper>
    </Box>
  );
}

// ===========================================================================
// Proposal / confirm
// ===========================================================================
function ProposalView({
  summary,
  instructions,
  onInstructionsChange,
  examples,
  onUpdateExample,
  onRemoveExample,
  onAddExample,
  confirming,
  onConfirm,
  onBack,
}: {
  summary: string;
  instructions: string;
  onInstructionsChange: (v: string) => void;
  examples: TeachExample[];
  onUpdateExample: (idx: number, patch: Partial<TeachExample>) => void;
  onRemoveExample: (idx: number) => void;
  onAddExample: () => void;
  confirming: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 4, maxWidth: 820, mx: 'auto', width: '100%' }}>
      <Button startIcon={<BackIcon />} onClick={onBack} sx={{ mb: 2 }} disabled={confirming}>
        Back to conversation
      </Button>

      <Typography variant="h6" fontWeight={600} sx={{ mb: 0.5 }}>
        Here's what I learned
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Read this over. Edit anything that's not quite right, then save it. From now on I'll use
        this whenever I read these documents.
      </Typography>

      {summary && (
        <Alert severity="info" icon={<AiIcon />} sx={{ mb: 3 }}>
          {summary}
        </Alert>
      )}

      <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1 }}>
        How to read these documents
      </Typography>
      <TextField
        fullWidth
        multiline
        minRows={5}
        value={instructions}
        onChange={(e) => onInstructionsChange(e.target.value)}
        disabled={confirming}
        sx={{ mb: 3 }}
      />

      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="subtitle2" fontWeight={600}>
          Examples
        </Typography>
        <Button size="small" startIcon={<AddIcon />} onClick={onAddExample} disabled={confirming}>
          Add example
        </Button>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        Concrete cases that show me the right answer for a field.
      </Typography>

      <Stack spacing={1.5} sx={{ mb: 3 }}>
        {examples.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No examples — that's fine, the instructions above are enough.
          </Typography>
        )}
        {examples.map((ex, idx) => (
          <Paper key={idx} variant="outlined" sx={{ p: 2 }}>
            <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, flex: 1 }}>
                <Box sx={{ display: 'flex', gap: 1.5 }}>
                  <TextField
                    label="Field"
                    size="small"
                    value={ex.field}
                    onChange={(e) => onUpdateExample(idx, { field: e.target.value })}
                    disabled={confirming}
                    sx={{ flex: 1 }}
                  />
                  <TextField
                    label="Value"
                    size="small"
                    value={ex.value}
                    onChange={(e) => onUpdateExample(idx, { value: e.target.value })}
                    disabled={confirming}
                    sx={{ flex: 1 }}
                  />
                </Box>
                <TextField
                  label="Note (why / how to find it)"
                  size="small"
                  value={ex.note}
                  onChange={(e) => onUpdateExample(idx, { note: e.target.value })}
                  disabled={confirming}
                  fullWidth
                />
              </Box>
              <Tooltip title="Remove example">
                <span>
                  <IconButton onClick={() => onRemoveExample(idx)} disabled={confirming} size="small">
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
          </Paper>
        ))}
      </Stack>

      <Button
        variant="contained"
        size="large"
        startIcon={confirming ? <CircularProgress size={18} color="inherit" /> : <CheckCircleIcon />}
        onClick={onConfirm}
        disabled={confirming}
      >
        {confirming ? 'Saving…' : 'Confirm & save'}
      </Button>
    </Paper>
  );
}

// ===========================================================================
// Done
// ===========================================================================
function DoneView({
  supplierLabel,
  docTypeLabel,
  onTeachAnother,
}: {
  supplierLabel: string;
  docTypeLabel: string;
  onTeachAnother: () => void;
}) {
  const navigate = useNavigate();
  return (
    <Paper variant="outlined" sx={{ p: 5, maxWidth: 560, mx: 'auto', width: '100%', textAlign: 'center' }}>
      <CheckCircleIcon color="success" sx={{ fontSize: 56, mb: 2 }} />
      <Typography variant="h6" fontWeight={600} sx={{ mb: 1 }}>
        All set — thank you!
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        {supplierLabel && docTypeLabel ? (
          <Fragment>
            Profile updated for <strong>{supplierLabel}</strong> / <strong>{docTypeLabel}</strong>.
            Future documents will use what you taught me.
          </Fragment>
        ) : (
          <Fragment>This profile is saved. Future documents will use what you taught me.</Fragment>
        )}
      </Typography>
      <Stack direction="row" spacing={2} justifyContent="center">
        <Button variant="outlined" onClick={onTeachAnother}>
          Teach another
        </Button>
        <Button variant="contained" onClick={() => navigate('/review')}>
          Go to Review Queue
        </Button>
      </Stack>
    </Paper>
  );
}
