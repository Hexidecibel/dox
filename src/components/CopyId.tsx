import { useState } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import { ContentCopy as CopyIcon, Check as CheckIcon } from '@mui/icons-material';

interface CopyIdProps {
  id: string;
  label?: string;
}

export function CopyId({ id, label }: CopyIdProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: ignore
    }
  };

  const truncated = id.slice(0, 8);

  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }}>
      {label && (
        <Typography
          component="span"
          variant="caption"
          color="text.secondary"
          sx={{ mr: 0.25 }}
        >
          {label}
        </Typography>
      )}
      <Typography
        component="span"
        variant="caption"
        sx={{
          fontFamily: 'monospace',
          color: 'text.secondary',
          fontSize: '0.75rem',
        }}
      >
        {truncated}
      </Typography>
      <Tooltip title={copied ? 'Copied!' : 'Copy ID'} arrow>
        <IconButton
          size="small"
          onClick={handleCopy}
          sx={{ p: 0.25, ml: 0.25 }}
        >
          {copied ? (
            <CheckIcon sx={{ fontSize: 14, color: 'success.main' }} />
          ) : (
            <CopyIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
          )}
        </IconButton>
      </Tooltip>
    </Box>
  );
}
