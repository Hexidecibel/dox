import { formatDateTime } from '../utils/format';
import {
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  IconButton,
  Typography,
  Box,
  Tooltip,
  Paper,
  Divider,
  useMediaQuery,
  useTheme,
  Card,
  CardContent,
} from '@mui/material';
import {
  Download as DownloadIcon,
  History as HistoryIcon,
  Visibility as PreviewIcon,
} from '@mui/icons-material';
import type { DocumentVersion } from '../lib/types';
import { api } from '../lib/api';

interface VersionHistoryProps {
  documentId: string;
  versions: DocumentVersion[];
  activeVersion?: number;
  onPreviewVersion?: (version: DocumentVersion) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function VersionHistory({ documentId, versions, activeVersion, onPreviewVersion }: VersionHistoryProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  if (versions.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
        No versions uploaded yet.
      </Typography>
    );
  }

  if (isMobile) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {versions.map((version) => (
          <Card
            key={version.id}
            variant="outlined"
            sx={{
              borderColor: activeVersion === version.version_number ? 'primary.main' : undefined,
              borderWidth: activeVersion === version.version_number ? 2 : 1,
            }}
          >
            <CardContent sx={{ pb: '12px !important' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                <Typography
                  variant="caption"
                  sx={{
                    bgcolor: 'primary.main',
                    color: 'primary.contrastText',
                    borderRadius: 1,
                    px: 0.8,
                    py: 0.2,
                    fontWeight: 700,
                    fontSize: '0.7rem',
                  }}
                >
                  v{version.version_number}
                </Typography>
                <Box>
                  {onPreviewVersion && (
                    <Tooltip title="Preview this version">
                      <IconButton
                        size="small"
                        onClick={() => {
                          onPreviewVersion(version);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                        color={activeVersion === version.version_number ? 'primary' : 'default'}
                      >
                        <PreviewIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                  <IconButton
                    size="small"
                    onClick={() => api.documents.download(documentId, version.version_number)}
                  >
                    <DownloadIcon fontSize="small" />
                  </IconButton>
                </Box>
              </Box>
              <Typography variant="body2" fontWeight={500}>
                {version.file_name}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {formatFileSize(version.file_size)}
              </Typography>
              {version.change_notes && (
                <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                  {version.change_notes}
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
                {version.uploader_name && `${version.uploader_name} · `}
                {formatDateTime(version.created_at)}
              </Typography>
            </CardContent>
          </Card>
        ))}
      </Box>
    );
  }

  return (
    <Paper variant="outlined">
      <Box sx={{ px: 2, py: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
        <HistoryIcon fontSize="small" color="primary" />
        <Typography variant="subtitle2" fontWeight={600}>
          Version History ({versions.length})
        </Typography>
      </Box>
      <Divider />
      <List disablePadding>
        {versions.map((version, index) => (
          <ListItem
            key={version.id}
            divider={index < versions.length - 1}
            sx={{
              bgcolor: activeVersion === version.version_number ? 'action.selected' : undefined,
            }}
            secondaryAction={
              <Box sx={{ display: 'flex', gap: 0.5 }}>
                {onPreviewVersion && (
                  <Tooltip title={`Preview v${version.version_number}`}>
                    <IconButton
                      edge="end"
                      onClick={() => {
                        onPreviewVersion(version);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      color={activeVersion === version.version_number ? 'primary' : 'default'}
                    >
                      <PreviewIcon />
                    </IconButton>
                  </Tooltip>
                )}
                <Tooltip title={`Download v${version.version_number}`}>
                  <IconButton
                    edge="end"
                    onClick={() => api.documents.download(documentId, version.version_number)}
                  >
                    <DownloadIcon />
                  </IconButton>
                </Tooltip>
              </Box>
            }
          >
            <ListItemIcon sx={{ minWidth: 40 }}>
              <Typography
                variant="caption"
                sx={{
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  borderRadius: 1,
                  px: 0.8,
                  py: 0.2,
                  fontWeight: 700,
                  fontSize: '0.7rem',
                }}
              >
                v{version.version_number}
              </Typography>
            </ListItemIcon>
            <ListItemText
              primary={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" fontWeight={500}>
                    {version.file_name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    ({formatFileSize(version.file_size)})
                  </Typography>
                </Box>
              }
              secondary={
                <Box component="span">
                  {version.change_notes && (
                    <Typography variant="caption" display="block" sx={{ mt: 0.25 }}>
                      {version.change_notes}
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
                    {version.uploader_name && `${version.uploader_name} · `}
                    {formatDateTime(version.created_at)}
                  </Typography>
                </Box>
              }
            />
          </ListItem>
        ))}
      </List>
    </Paper>
  );
}
