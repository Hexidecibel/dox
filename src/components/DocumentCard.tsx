import { formatDate } from '../utils/format';
import {
  Card,
  CardContent,
  CardActions,
  Typography,
  Chip,
  Box,
  Button,
  IconButton,
  Tooltip,
} from '@mui/material';
import {
  Download as DownloadIcon,
  Visibility as ViewIcon,
  Description as DocIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import type { Document } from '../lib/types';
import { api } from '../lib/api';

interface DocumentCardProps {
  document: Document;
}

const statusColors: Record<string, 'success' | 'warning' | 'error'> = {
  active: 'success',
  archived: 'warning',
  deleted: 'error',
};

export function DocumentCard({ document: doc }: DocumentCardProps) {
  const navigate = useNavigate();

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    api.documents.download(doc.id);
  };

  return (
    <Card
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        '&:hover': {
          borderColor: 'primary.light',
          boxShadow: '0 2px 8px rgba(26, 54, 93, 0.08)',
        },
      }}
      onClick={() => navigate(`/documents/${doc.id}`)}
    >
      <CardContent sx={{ flex: 1, pb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1 }}>
          <DocIcon sx={{ color: 'primary.main', mt: 0.25, fontSize: '1.25rem' }} />
          <Typography
            variant="h6"
            component="h3"
            sx={{
              fontSize: '0.9375rem',
              fontWeight: 600,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {doc.title}
          </Typography>
          <Chip
            label={`v${doc.current_version}`}
            size="small"
            color="primary"
            variant="outlined"
            sx={{ flexShrink: 0 }}
          />
        </Box>

        {doc.description && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              mb: 1.5,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {doc.description}
          </Typography>
        )}

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
          {doc.category && (
            <Chip label={doc.category} size="small" color="secondary" variant="outlined" />
          )}
          {doc.documentTypeName && (
            <Chip label={doc.documentTypeName} size="small" color="info" variant="outlined" />
          )}
          <Chip
            label={doc.status}
            size="small"
            color={statusColors[doc.status] || 'default'}
            variant="filled"
            sx={{ textTransform: 'capitalize' }}
          />
        </Box>

        {doc.tags.length > 0 && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
            {doc.tags.slice(0, 4).map((tag) => (
              <Chip key={tag} label={tag} size="small" variant="outlined" sx={{ fontSize: '0.7rem' }} />
            ))}
            {doc.tags.length > 4 && (
              <Chip label={`+${doc.tags.length - 4}`} size="small" variant="outlined" sx={{ fontSize: '0.7rem' }} />
            )}
          </Box>
        )}

        <Typography variant="caption" color="text.secondary">
          {doc.creator_name && `By ${doc.creator_name} · `}
          {formatDate(doc.created_at)}
        </Typography>
      </CardContent>

      <CardActions sx={{ pt: 0, px: 2, pb: 1.5 }}>
        <Tooltip title="View details">
          <IconButton size="small" onClick={(e) => { e.stopPropagation(); navigate(`/documents/${doc.id}`); }}>
            <ViewIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Download latest">
          <IconButton size="small" onClick={handleDownload}>
            <DownloadIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Button
          size="small"
          variant="text"
          onClick={(e) => { e.stopPropagation(); navigate(`/documents/${doc.id}`); }}
          sx={{ ml: 'auto' }}
        >
          Open
        </Button>
      </CardActions>
    </Card>
  );
}
