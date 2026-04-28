import { Box, Chip } from '@mui/material';
import { versionInfo } from '../lib/versionInfo';
import { useReleaseNotes } from '../contexts/ReleaseNotesContext';

export function VersionChip() {
  const { openReleaseNotes } = useReleaseNotes();

  return (
    <Box
      sx={{
        position: 'fixed',
        bottom: 12,
        right: 12,
        zIndex: (t) => t.zIndex.tooltip,
      }}
    >
      <Chip
        label={versionInfo.label}
        size="small"
        variant="outlined"
        onClick={() => openReleaseNotes()}
        sx={{
          color: 'text.secondary',
          bgcolor: 'background.paper',
          cursor: 'pointer',
          fontFamily: 'monospace',
          fontSize: '0.7rem',
          opacity: 0.8,
          '&:hover': { opacity: 1 },
        }}
      />
    </Box>
  );
}
