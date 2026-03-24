import { useState, useRef, useCallback } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Box,
  Typography,
  LinearProgress,
  IconButton,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  CloudUpload as UploadIcon,
  Close as CloseIcon,
  InsertDriveFile as FileIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';

interface UploadDialogProps {
  open: boolean;
  onClose: () => void;
  documentId: string;
  onSuccess: () => void;
}

export function UploadDialog({ open, onClose, documentId, onSuccess }: UploadDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [changeNotes, setChangeNotes] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const handleFileSelect = (selectedFile: File) => {
    setFile(selectedFile);
    setError('');
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) {
      handleFileSelect(droppedFile);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleSubmit = async () => {
    if (!file) {
      setError('Please select a file');
      return;
    }
    setUploading(true);
    setError('');
    try {
      await api.documents.upload(documentId, file, changeNotes || undefined);
      onSuccess();
      handleReset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleReset = () => {
    setFile(null);
    setChangeNotes('');
    setError('');
    setDragOver(false);
    onClose();
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <Dialog open={open} onClose={handleReset} maxWidth="sm" fullWidth fullScreen={isMobile}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Upload New Version
        <IconButton onClick={handleReset} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Box
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => fileInputRef.current?.click()}
          sx={{
            border: '2px dashed',
            borderColor: dragOver ? 'primary.main' : 'divider',
            borderRadius: 1.5,
            p: { xs: 3, sm: 4 },
            textAlign: 'center',
            cursor: 'pointer',
            bgcolor: dragOver ? 'action.hover' : 'transparent',
            transition: 'all 0.2s',
            mb: 2,
            minHeight: { xs: 120, sm: 'auto' },
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            '&:hover': {
              borderColor: 'primary.main',
              bgcolor: 'action.hover',
            },
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFileSelect(f);
            }}
          />
          {file ? (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
              <FileIcon color="primary" />
              <Box>
                <Typography variant="body1" fontWeight={600}>
                  {file.name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatFileSize(file.size)}
                </Typography>
              </Box>
            </Box>
          ) : (
            <>
              <UploadIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
              <Typography variant="body1" gutterBottom>
                {isMobile ? 'Tap to select a file' : 'Drag and drop a file here, or click to browse'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Any file type accepted
              </Typography>
            </>
          )}
        </Box>

        <TextField
          label="Change Notes"
          placeholder="Describe what changed in this version..."
          multiline
          rows={3}
          fullWidth
          value={changeNotes}
          onChange={(e) => setChangeNotes(e.target.value)}
          disabled={uploading}
        />

        {uploading && <LinearProgress sx={{ mt: 2 }} />}

        {error && (
          <Typography color="error" variant="body2" sx={{ mt: 1 }}>
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleReset} disabled={uploading}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!file || uploading}
          startIcon={<UploadIcon />}
        >
          {uploading ? 'Uploading...' : 'Upload'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
