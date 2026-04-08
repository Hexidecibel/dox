import { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Grid,
  Card,
  CardContent,
  Button,
  CircularProgress,
  Alert,
  Snackbar,
  IconButton,
  Tooltip,
} from '@mui/material';
import {
  Description as DocsIcon,
  CloudUpload as UploadIcon,
  TrendingUp as TrendingIcon,
  Email as EmailIcon,
  ContentCopy as CopyIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTenant } from '../contexts/TenantContext';
import { api } from '../lib/api';
import type { Document } from '../lib/types';
import { DocumentCard } from '../components/DocumentCard';
import { RoleGuard } from '../components/RoleGuard';

export function Dashboard() {
  const { user } = useAuth();
  const { selectedTenant } = useTenant();
  const navigate = useNavigate();
  const [recentDocs, setRecentDocs] = useState<Document[]>([]);
  const [totalDocs, setTotalDocs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copySnackbar, setCopySnackbar] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const result = await api.documents.list({ limit: 6 });
        setRecentDocs(result.documents);
        setTotalDocs(result.total);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Box sx={{ mb: 4 }}>
        <Typography variant="h4" fontWeight={700} gutterBottom>
          Welcome back, {user?.name}
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Here is an overview of your document portal.
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {/* Stats Cards */}
      <Grid container spacing={2} sx={{ mb: 4 }}>
        <Grid item xs={12} sm={6} md={4}>
          <Card>
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Box sx={{ width: 48, height: 48, borderRadius: 1.5, bgcolor: 'primary.main', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <DocsIcon sx={{ fontSize: 24, color: 'white' }} />
              </Box>
              <Box>
                <Typography variant="h4" fontWeight={700}>
                  {totalDocs}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Total Documents
                </Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={4}>
          <Card>
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Box sx={{ width: 48, height: 48, borderRadius: 1.5, bgcolor: 'secondary.main', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <TrendingIcon sx={{ fontSize: 24, color: 'white' }} />
              </Box>
              <Box>
                <Typography variant="h4" fontWeight={700}>
                  {recentDocs.length}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Recent Uploads
                </Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>
        <RoleGuard roles={['super_admin', 'org_admin', 'user']}>
          <Grid item xs={12} sm={6} md={4}>
            <Card
              sx={{ cursor: 'pointer', transition: 'border-color 0.15s', '&:hover': { borderColor: 'primary.light' } }}
              onClick={() => navigate('/documents')}
            >
              <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <Box sx={{ width: 48, height: 48, borderRadius: 1.5, bgcolor: 'primary.main', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <UploadIcon sx={{ fontSize: 24, color: 'white' }} />
                </Box>
                <Box>
                  <Typography variant="h6" fontWeight={600}>
                    Upload Document
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Add a new document
                  </Typography>
                </Box>
              </CardContent>
            </Card>
          </Grid>
        </RoleGuard>
      </Grid>

      {/* Email Documents */}
      {selectedTenant && (
        <Card sx={{ mb: 4 }}>
          <CardContent sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
            <Box sx={{ width: 48, height: 48, borderRadius: 1.5, bgcolor: 'info.main', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <EmailIcon sx={{ fontSize: 24, color: 'white' }} />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="h6" fontWeight={600} gutterBottom>
                Email Documents
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                Forward documents to this address for automatic processing:
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                <Typography
                  variant="body1"
                  fontWeight={600}
                  sx={{
                    fontFamily: 'monospace',
                    bgcolor: 'action.hover',
                    px: 1.5,
                    py: 0.75,
                    borderRadius: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {selectedTenant.slug}@dox.cush.rocks
                </Typography>
                <Tooltip title="Copy email address">
                  <IconButton
                    size="small"
                    onClick={() => {
                      navigator.clipboard.writeText(`${selectedTenant.slug}@dox.cush.rocks`);
                      setCopySnackbar(true);
                    }}
                  >
                    <CopyIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
              <Typography variant="body2" color="text.secondary">
                Attachments will be automatically extracted, classified, and added to your document queue.
              </Typography>
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Recent Documents */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h6" fontWeight={600}>
          Recent Documents
        </Typography>
        <Button onClick={() => navigate('/documents')} size="small">
          View All
        </Button>
      </Box>

      {recentDocs.length === 0 ? (
        <Card>
          <CardContent sx={{ textAlign: 'center', py: 4 }}>
            <DocsIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
            <Typography variant="body1" color="text.secondary">
              No documents yet. Get started by uploading your first document.
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Grid container spacing={2}>
          {recentDocs.map((doc) => (
            <Grid item xs={12} sm={6} md={4} key={doc.id}>
              <DocumentCard document={doc} />
            </Grid>
          ))}
        </Grid>
      )}

      <Snackbar
        open={copySnackbar}
        autoHideDuration={2000}
        onClose={() => setCopySnackbar(false)}
        message="Email address copied to clipboard"
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}
