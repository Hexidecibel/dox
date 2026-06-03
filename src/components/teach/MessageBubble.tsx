import { Box, Paper, Typography, Avatar } from '@mui/material';
import { AutoAwesome as AiIcon, Person as SmeIcon } from '@mui/icons-material';
import type { TeachMessage } from '../../lib/types';

/**
 * Renders a single teach-chat turn — an AI question or an SME (domain expert)
 * answer. Pure presentational: pass a {@link TeachMessage}. System messages are
 * filtered out by the caller, not here.
 *
 * `compact` tightens the bubble for the embedded side-panel variant
 * (TeachPanel) where horizontal space is scarce.
 */
export default function MessageBubble({
  message,
  compact = false,
}: {
  message: TeachMessage;
  compact?: boolean;
}) {
  const isAi = message.role === 'ai';
  const avatarSize = compact ? 26 : 32;
  return (
    <Box sx={{ display: 'flex', flexDirection: isAi ? 'row' : 'row-reverse', gap: compact ? 1 : 1.5 }}>
      <Avatar
        sx={{
          bgcolor: isAi ? 'primary.main' : 'grey.400',
          width: avatarSize,
          height: avatarSize,
          flexShrink: 0,
        }}
      >
        {isAi ? <AiIcon fontSize="small" /> : <SmeIcon fontSize="small" />}
      </Avatar>
      <Paper
        elevation={0}
        sx={{
          p: compact ? 1.25 : 1.5,
          maxWidth: compact ? '88%' : '78%',
          bgcolor: isAi ? 'action.hover' : 'primary.main',
          color: isAi ? 'text.primary' : 'primary.contrastText',
          borderRadius: 2,
        }}
      >
        <Typography variant={compact ? 'body2' : 'body1'} sx={{ whiteSpace: 'pre-wrap' }}>
          {message.content}
        </Typography>
      </Paper>
    </Box>
  );
}
