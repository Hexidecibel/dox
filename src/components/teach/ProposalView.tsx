import {
  Box,
  Paper,
  Typography,
  Button,
  TextField,
  CircularProgress,
  Alert,
  IconButton,
  Stack,
  Tooltip,
} from '@mui/material';
import {
  AutoAwesome as AiIcon,
  CheckCircle as CheckCircleIcon,
  ArrowBack as BackIcon,
  Add as AddIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import type { TeachProposal, TeachExample } from '../../lib/types';

/**
 * Review/edit surface for a synthesized teach proposal: the AI summary, the
 * editable extraction instructions, and the few-shot examples. On confirm the
 * parent writes these to the (supplier, document_type) profile.
 *
 * Pure presentational — the parent owns `instructions` / `examples` state and
 * the confirm/back actions. Example add/update/remove are expressed through the
 * single `onExamplesChange` callback so the contract stays small; the array
 * mutation helpers live here.
 *
 * `compact` drops the page chrome (max-width centering, heavy padding) for the
 * embedded side-panel variant.
 */
export default function ProposalView({
  proposal,
  instructions,
  onInstructionsChange,
  examples,
  onExamplesChange,
  onConfirm,
  onBack,
  confirming,
  compact = false,
}: {
  proposal: TeachProposal;
  instructions: string;
  onInstructionsChange: (v: string) => void;
  examples: TeachExample[];
  onExamplesChange: (examples: TeachExample[]) => void;
  onConfirm: () => void;
  onBack: () => void;
  confirming: boolean;
  compact?: boolean;
}) {
  const updateExample = (idx: number, patch: Partial<TeachExample>) =>
    onExamplesChange(examples.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  const removeExample = (idx: number) =>
    onExamplesChange(examples.filter((_, i) => i !== idx));
  const addExample = () =>
    onExamplesChange([...examples, { field: '', value: '', note: '' }]);

  const body = (
    <>
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

      {proposal.summary && (
        <Alert severity="info" icon={<AiIcon />} sx={{ mb: 3 }}>
          {proposal.summary}
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
        <Button size="small" startIcon={<AddIcon />} onClick={addExample} disabled={confirming}>
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
                    onChange={(e) => updateExample(idx, { field: e.target.value })}
                    disabled={confirming}
                    sx={{ flex: 1 }}
                  />
                  <TextField
                    label="Value"
                    size="small"
                    value={ex.value}
                    onChange={(e) => updateExample(idx, { value: e.target.value })}
                    disabled={confirming}
                    sx={{ flex: 1 }}
                  />
                </Box>
                <TextField
                  label="Note (why / how to find it)"
                  size="small"
                  value={ex.note}
                  onChange={(e) => updateExample(idx, { note: e.target.value })}
                  disabled={confirming}
                  fullWidth
                />
              </Box>
              <Tooltip title="Remove example">
                <span>
                  <IconButton onClick={() => removeExample(idx)} disabled={confirming} size="small">
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
    </>
  );

  if (compact) {
    return (
      <Paper variant="outlined" sx={{ p: 2.5, width: '100%', overflowY: 'auto' }}>
        {body}
      </Paper>
    );
  }

  return (
    <Paper variant="outlined" sx={{ p: 4, maxWidth: 820, mx: 'auto', width: '100%' }}>
      {body}
    </Paper>
  );
}
