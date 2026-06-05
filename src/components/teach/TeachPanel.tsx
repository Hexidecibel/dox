import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Chip,
  Collapse,
  Stack,
} from '@mui/material';
import {
  School as TeachIcon,
  CheckCircle as CheckCircleIcon,
  ExpandMore as ExpandMoreIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import ChatView, { type UncertaintyIssue } from './ChatView';
import ProposalView from './ProposalView';
import type {
  TeachMessage,
  TeachProposal,
  TeachExample,
  TeachSessionSummary,
} from '../../lib/types';

const STATUS_CHIP: Record<
  TeachSessionSummary['status'],
  { label: string; color: 'success' | 'default' | 'warning' | 'info' }
> = {
  confirmed: { label: 'Confirmed', color: 'success' },
  abandoned: { label: 'Abandoned', color: 'default' },
  synthesized: { label: 'Draft', color: 'info' },
  open: { label: 'Active', color: 'warning' },
};

type Phase = 'loading' | 'chat' | 'proposal' | 'done' | 'error';

/**
 * Embeddable teach panel — designed to sit in a narrow side column next to a
 * document (e.g. dropped into the review screen). Owns its own teach session
 * lifecycle for a single (supplier, document_type) pair.
 *
 * Lifecycle:
 *  - mount / supplier|doctype prop change → `api.teach.createSession`
 *    (resumes-or-creates; idempotent per pair), seed messages + issues → chat.
 *  - chat → `api.teach.postMessage`, tracking `ready_to_synthesize`.
 *  - synthesize → `api.teach.synthesize` → proposal.
 *  - confirm → `api.teach.confirm` → `onTaught()` + collapse to a compact
 *    "✓ Taught" state.
 *
 * Guard: if `supplierId` is falsy (supplier not yet confirmed) it renders a
 * muted hint instead of starting a session.
 */
export default function TeachPanel({
  supplierId,
  supplierName,
  documentTypeId,
  tenantId,
  onTaught,
}: {
  supplierId: string;
  supplierName?: string;
  documentTypeId: string;
  tenantId?: string;
  onTaught?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TeachMessage[]>([]);
  const [issues, setIssues] = useState<UncertaintyIssue[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [readyToSynthesize, setReadyToSynthesize] = useState(false);

  const [synthesizing, setSynthesizing] = useState(false);
  const [proposal, setProposal] = useState<TeachProposal | null>(null);
  const [editInstructions, setEditInstructions] = useState('');
  const [editExamples, setEditExamples] = useState<TeachExample[]>([]);
  const [confirming, setConfirming] = useState(false);

  // Past chats (non-active sessions) for this pair.
  const [pastSessions, setPastSessions] = useState<TeachSessionSummary[]>([]);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [pastTranscript, setPastTranscript] = useState<TeachMessage[]>([]);
  const [pastTranscriptIssues, setPastTranscriptIssues] = useState<UncertaintyIssue[]>([]);
  const [loadingTranscript, setLoadingTranscript] = useState(false);

  // Tracks the most recent (supplier, doctype) we kicked a session for, so a
  // late-resolving createSession from a previous pair can't clobber state.
  const pairRef = useRef<string>('');

  // ---------------------------------------------------------------------------
  // Start (resume-or-create) on mount and whenever the pair changes.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!supplierId || !documentTypeId) return;
    const pair = `${supplierId}::${documentTypeId}`;
    pairRef.current = pair;

    let cancelled = false;
    // Reset to a clean slate for the new pair.
    setPhase('loading');
    setError(null);
    setSessionId(null);
    setMessages([]);
    setIssues([]);
    setDraft('');
    setReadyToSynthesize(false);
    setProposal(null);
    setEditInstructions('');
    setEditExamples([]);
    setExpandedSessionId(null);
    setPastTranscript([]);
    setPastTranscriptIssues([]);

    api.teach
      .createSession({ supplier_id: supplierId, document_type_id: documentTypeId, tenant_id: tenantId })
      .then((res) => {
        if (cancelled || pairRef.current !== pair) return;
        setSessionId(res.session_id);
        setMessages(res.messages || []);
        setIssues((res.issues || []) as UncertaintyIssue[]);
        setPhase('chat');
      })
      .catch((e) => {
        if (cancelled || pairRef.current !== pair) return;
        setError(e instanceof Error ? e.message : 'Could not start the teaching session');
        setPhase('error');
      });

    return () => {
      cancelled = true;
    };
  }, [supplierId, documentTypeId, tenantId]);

  // ---------------------------------------------------------------------------
  // Past chats: fetch the non-active sessions for the pair. `phase` is in the
  // deps so the list refreshes after the live session reaches a terminal state
  // (e.g. just confirmed → now shows up as a past chat).
  // ---------------------------------------------------------------------------
  const reloadPastSessions = useCallback(() => {
    if (!supplierId || !documentTypeId) {
      setPastSessions([]);
      return;
    }
    const pair = `${supplierId}::${documentTypeId}`;
    api.teach
      .listSessions({ supplier_id: supplierId, document_type_id: documentTypeId, tenant_id: tenantId })
      .then((res) => {
        if (pairRef.current !== pair) return;
        setPastSessions(res.sessions || []);
      })
      .catch(() => {
        if (pairRef.current !== pair) return;
        setPastSessions([]);
      });
  }, [supplierId, documentTypeId, tenantId]);

  useEffect(() => {
    reloadPastSessions();
  }, [reloadPastSessions, phase]);

  const handleToggleSession = useCallback(
    (id: string) => {
      if (expandedSessionId === id) {
        setExpandedSessionId(null);
        return;
      }
      setExpandedSessionId(id);
      setPastTranscript([]);
      setPastTranscriptIssues([]);
      setLoadingTranscript(true);
      api.teach
        .getSession(id, tenantId)
        .then((res) => {
          setPastTranscript(res.messages || []);
          setPastTranscriptIssues((res.issues || []) as UncertaintyIssue[]);
        })
        .catch(() => {
          setPastTranscript([]);
          setPastTranscriptIssues([]);
        })
        .finally(() => setLoadingTranscript(false));
    },
    [expandedSessionId, tenantId],
  );

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  const handleSend = useCallback(async () => {
    const content = draft.trim();
    if (!content || !sessionId) return;
    setSending(true);
    setError(null);
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
      onTaught?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the profile');
    } finally {
      setConfirming(false);
    }
  }, [sessionId, editInstructions, editExamples, tenantId, onTaught]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Guard: no confirmed supplier yet.
  if (!supplierId) {
    return (
      <Paper variant="outlined" sx={{ p: 2, textAlign: 'center' }}>
        <TeachIcon color="disabled" sx={{ fontSize: 28, mb: 0.5 }} />
        <Typography variant="body2" color="text.secondary">
          Confirm the supplier to start teaching.
        </Typography>
      </Paper>
    );
  }

  if (phase === 'done') {
    return (
      <Paper variant="outlined" sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
        <CheckCircleIcon color="success" />
        <Typography variant="body2" fontWeight={600}>
          Taught — future docs use this
        </Typography>
      </Paper>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 1.5, height: '100%' }}>
      {/* Compact header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <TeachIcon color="primary" fontSize="small" />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" fontWeight={700} noWrap>
            Teach the AI
          </Typography>
          {supplierName && (
            <Typography variant="caption" color="text.secondary" noWrap>
              {supplierName}
            </Typography>
          )}
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ py: 0 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {phase === 'loading' ? (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, py: 4 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">
            Starting…
          </Typography>
        </Box>
      ) : phase === 'error' ? (
        <Box sx={{ textAlign: 'center', py: 2 }}>
          <Button
            size="small"
            variant="outlined"
            onClick={() => {
              // Re-trigger the start effect by nudging the pair ref.
              pairRef.current = '';
              setPhase('loading');
              // Effect deps unchanged, so kick a manual retry.
              void api.teach
                .createSession({ supplier_id: supplierId, document_type_id: documentTypeId, tenant_id: tenantId })
                .then((res) => {
                  setSessionId(res.session_id);
                  setMessages(res.messages || []);
                  setIssues((res.issues || []) as UncertaintyIssue[]);
                  setError(null);
                  setPhase('chat');
                })
                .catch((e) => {
                  setError(e instanceof Error ? e.message : 'Could not start the teaching session');
                  setPhase('error');
                });
            }}
          >
            Retry
          </Button>
        </Box>
      ) : phase === 'proposal' && proposal ? (
        <ProposalView
          compact
          proposal={proposal}
          instructions={editInstructions}
          onInstructionsChange={setEditInstructions}
          examples={editExamples}
          onExamplesChange={setEditExamples}
          onConfirm={handleConfirm}
          onBack={() => setPhase('chat')}
          confirming={confirming}
        />
      ) : (
        <ChatView
          compact
          messages={messages}
          issues={issues}
          draft={draft}
          onDraftChange={setDraft}
          onSend={handleSend}
          sending={sending}
          readyToSynthesize={readyToSynthesize}
          onSynthesize={handleSynthesize}
          synthesizing={synthesizing}
        />
      )}

      {/* Past chats — collapsed by default, contextual to this supplier×doctype. */}
      {pastSessions.length > 0 && (
        <Accordion
          disableGutters
          elevation={0}
          variant="outlined"
          sx={{ '&:before': { display: 'none' }, borderRadius: 1, mt: 'auto' }}
        >
          <AccordionSummary expandIcon={<ExpandMoreIcon fontSize="small" />} sx={{ minHeight: 40 }}>
            <Typography variant="subtitle2" fontWeight={600}>
              Past chats ({pastSessions.length})
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ p: 0 }}>
            <Stack divider={<Box sx={{ borderBottom: 1, borderColor: 'divider' }} />}>
              {pastSessions.map((s) => {
                const chip = STATUS_CHIP[s.status] ?? STATUS_CHIP.abandoned;
                const preview = s.proposed_instructions
                  ? s.proposed_instructions.slice(0, 80) +
                    (s.proposed_instructions.length > 80 ? '…' : '')
                  : '—';
                const isOpen = expandedSessionId === s.id;
                return (
                  <Box key={s.id}>
                    <Box
                      onClick={() => handleToggleSession(s.id)}
                      sx={{
                        px: 1.5,
                        py: 1,
                        cursor: 'pointer',
                        '&:hover': { bgcolor: 'action.hover' },
                      }}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.25 }}>
                        <Chip label={chip.label} size="small" color={chip.color} variant="outlined" />
                        <Typography variant="caption" color="text.secondary">
                          {new Date(s.created_at).toLocaleString()}
                        </Typography>
                      </Box>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{
                          display: 'block',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {preview}
                      </Typography>
                    </Box>
                    <Collapse in={isOpen} unmountOnExit>
                      <Box sx={{ px: 1, pb: 1.5, height: 360, display: 'flex' }}>
                        {loadingTranscript ? (
                          <Box
                            sx={{
                              flex: 1,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <CircularProgress size={18} />
                          </Box>
                        ) : (
                          <ChatView
                            compact
                            readOnly
                            messages={pastTranscript}
                            issues={pastTranscriptIssues}
                            draft=""
                            onDraftChange={() => {}}
                            onSend={() => {}}
                            sending={false}
                            readyToSynthesize={false}
                            onSynthesize={() => {}}
                          />
                        )}
                      </Box>
                    </Collapse>
                  </Box>
                );
              })}
            </Stack>
          </AccordionDetails>
        </Accordion>
      )}
    </Box>
  );
}
