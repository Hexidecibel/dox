import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  Button,
  CircularProgress,
  Alert,
} from '@mui/material';
import {
  School as TeachIcon,
  CheckCircle as CheckCircleIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import ChatView, { type UncertaintyIssue } from './ChatView';
import ProposalView from './ProposalView';
import type { TeachMessage, TeachProposal, TeachExample } from '../../lib/types';

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
    </Box>
  );
}
