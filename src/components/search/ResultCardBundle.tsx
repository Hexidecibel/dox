import { Box, Card, CardContent, Chip, Stack, Typography } from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';
import { useNavigate } from 'react-router-dom';
import { Snippet } from './Snippet';
import type { UniversalSearchBundle } from '../../../shared/types';

export interface ResultCardBundleProps {
  bundle: UniversalSearchBundle;
  onOpen?: (bundle: UniversalSearchBundle) => void;
}

export function ResultCardBundle({ bundle, onOpen }: ResultCardBundleProps) {
  const navigate = useNavigate();
  const open = () =>
    onOpen ? onOpen(bundle) : navigate(`/bundles/${bundle.id}`);
  return (
    <Card
      variant="outlined"
      sx={{
        mb: 1,
        cursor: 'pointer',
        '&:hover': { borderColor: 'primary.light' },
      }}
      onClick={open}
    >
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <FolderIcon sx={{ color: 'warning.main', mt: 0.25, fontSize: '1.1rem' }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }} noWrap>
              <Snippet text={bundle.name} />
            </Typography>
            {bundle.snippet && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                <Snippet text={bundle.snippet} />
              </Typography>
            )}
            <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }} useFlexGap>
              <Chip size="small" label="Bundle" variant="outlined" />
            </Stack>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}
