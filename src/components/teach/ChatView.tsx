import { useRef, useEffect } from 'react';
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
  Stack,
  Tooltip,
} from '@mui/material';
import {
  AutoAwesome as AiIcon,
  Send as SendIcon,
  Lightbulb as IssueIcon,
} from '@mui/icons-material';
import MessageBubble from './MessageBubble';
import type { TeachMessage } from '../../lib/types';

/**
 * Mirror of functions/lib/teach/uncertainty.ts — the analyzer's detected
 * ambiguities, shown to the SME as context for what the AI is unsure about.
 * Exported so both the standalone Teach page and the embedded TeachPanel can
 * type their issues state against the same shape.
 */
export interface UncertaintyIssue {
  id: string;
  field: string;
  kind: 'often-empty' | 'inconsistent' | 'implausible' | 'low-confidence';
  summary: string;
  severity: number;
  examples: Array<{ queue_item_id: string; file_name: string | null; value: string | null }>;
}

/**
 * The teach-chat conversation surface: transcript + composer + the optional
 * "what I'm unsure about" issues panel. Pure presentational — all data and
 * state lives in the parent (Teach page or TeachPanel), which wires the
 * callbacks. The transcript auto-scrolls on new messages / pending turns.
 *
 * `compact` switches to the narrow side-panel layout used by TeachPanel: the
 * issues panel stacks below the conversation instead of sitting beside it, and
 * fixed 70vh heights give way to flexing within the parent column.
 */
export default function ChatView({
  messages,
  issues,
  draft,
  onDraftChange,
  onSend,
  sending,
  readyToSynthesize,
  onSynthesize,
  synthesizing = false,
  compact = false,
}: {
  messages: TeachMessage[];
  issues: UncertaintyIssue[];
  draft: string;
  onDraftChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  readyToSynthesize: boolean;
  onSynthesize: () => void;
  synthesizing?: boolean;
  compact?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the transcript on new messages / pending turns.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending, synthesizing]);

  const transcript = (
    <>
      <Box ref={scrollRef} sx={{ flex: 1, overflowY: 'auto', p: compact ? 2 : 3 }}>
        <Stack spacing={compact ? 1.5 : 2}>
          {messages
            .filter((m) => m.role !== 'system')
            .map((m) => (
              <MessageBubble key={m.id} message={m} compact={compact} />
            ))}
          {(sending || synthesizing) && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 1 }}>
              <Avatar sx={{ bgcolor: 'primary.main', width: compact ? 26 : 32, height: compact ? 26 : 32 }}>
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
        <Box sx={{ px: compact ? 2 : 3, pt: 2 }}>
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
      <Box sx={{ p: compact ? 1.5 : 2, display: 'flex', gap: 1, alignItems: 'flex-end' }}>
        <TextField
          fullWidth
          multiline
          maxRows={6}
          size={compact ? 'small' : 'medium'}
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
    </>
  );

  const issuesPanel = issues.length > 0 && (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
      <IssueIcon color="warning" fontSize="small" />
      <Typography variant="subtitle2" fontWeight={600}>
        What I'm unsure about
      </Typography>
    </Box>
  );

  const issuesBody = issues.length > 0 && (
    <>
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
    </>
  );

  // Compact: single column, issues stacked below the conversation.
  if (compact) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minHeight: 0 }}>
        <Paper
          variant="outlined"
          sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 240 }}
        >
          {transcript}
        </Paper>
        {issues.length > 0 && (
          <Paper variant="outlined" sx={{ p: 2, maxHeight: 280, overflowY: 'auto' }}>
            {issuesPanel}
            {issuesBody}
          </Paper>
        )}
      </Box>
    );
  }

  // Full-screen: conversation + issues side panel.
  return (
    <Box sx={{ display: 'flex', gap: 2, flex: 1, minHeight: 0 }}>
      <Paper
        variant="outlined"
        sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, height: '70vh' }}
      >
        {transcript}
      </Paper>

      {issues.length > 0 && (
        <Paper
          variant="outlined"
          sx={{ width: 300, flexShrink: 0, p: 2, overflowY: 'auto', height: '70vh', display: { xs: 'none', md: 'block' } }}
        >
          {issuesPanel}
          {issuesBody}
        </Paper>
      )}
    </Box>
  );
}
