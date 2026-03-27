import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  ListItemIcon,
  Typography,
  CircularProgress,
  Box,
  Chip,
  IconButton,
  InputAdornment,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  Description as DocIcon,
  Search as SearchIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { Document } from '../lib/types';

interface DocumentPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (documentId: string, documentTitle: string) => void;
  excludeIds?: string[];
}

export function DocumentPicker({ open, onClose, onSelect, excludeIds = [] }: DocumentPickerProps) {
  const [search, setSearch] = useState('');
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(false);
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const loadDocuments = async (query: string) => {
    setLoading(true);
    try {
      if (query.trim()) {
        const result = await api.documents.search(query);
        setDocuments(result.documents.filter((d) => !excludeIds.includes(d.id)));
      } else {
        const result = await api.documents.list({ limit: 50 });
        setDocuments(result.documents.filter((d) => !excludeIds.includes(d.id)));
      }
    } catch {
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) {
      setSearch('');
      setDocuments([]);
      return;
    }
    loadDocuments('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      loadDocuments(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const handleSelect = (doc: Document) => {
    onSelect(doc.id, doc.title);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth fullScreen={isMobile}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Select Document
        <IconButton onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <TextField
          placeholder="Search documents..."
          fullWidth
          size="small"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
          }}
          sx={{ mb: 2, mt: 1 }}
        />

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={32} />
          </Box>
        ) : documents.length === 0 ? (
          <Typography color="text.secondary" textAlign="center" sx={{ py: 4 }}>
            {search ? 'No documents found' : 'No documents available'}
          </Typography>
        ) : (
          <List sx={{ maxHeight: 400, overflow: 'auto' }}>
            {documents.map((doc) => (
              <ListItem key={doc.id} disablePadding>
                <ListItemButton onClick={() => handleSelect(doc)}>
                  <ListItemIcon sx={{ minWidth: 36 }}>
                    <DocIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText
                    primary={doc.title}
                    secondary={
                      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                        {doc.documentTypeName && (
                          <Chip label={doc.documentTypeName} size="small" variant="outlined" sx={{ height: 20, fontSize: '0.7rem' }} />
                        )}
                        <Chip label={`v${doc.current_version}`} size="small" variant="outlined" sx={{ height: 20, fontSize: '0.7rem' }} />
                      </Box>
                    }
                  />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}
