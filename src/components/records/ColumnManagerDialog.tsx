/**
 * ColumnManagerDialog — surface every column on a sheet so the user can
 * edit / archive / add without having to be in Grid view. Grid's column-
 * header three-dot menu still works; this is a parallel entry point so
 * Kanban / Timeline / Calendar / Gallery / mobile users aren't stuck.
 *
 * Composition: this dialog wraps EditColumnDialog and AddColumnDialog
 * rather than reimplementing column-edit UX. Saves come back through
 * onColumnUpdated so the parent (SheetDetail) can keep its `columns`
 * array in sync the same way the Grid header menu does.
 */

import { useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  Close as CloseIcon,
  TextFields as TextIcon,
  Notes as LongTextIcon,
  Numbers as NumberIcon,
  AttachMoney as CurrencyIcon,
  Percent as PercentIcon,
  CalendarToday as DateIcon,
  Schedule as DateTimeIcon,
  Timer as DurationIcon,
  CheckBox as CheckboxIcon,
  ArrowDropDownCircleOutlined as DropdownIcon,
  ChecklistOutlined as MultiSelectIcon,
  PersonOutline as ContactIcon,
  AlternateEmail as EmailIcon,
  Link as UrlIcon,
  Phone as PhoneIcon,
  AttachFile as AttachmentIcon,
  Functions as FormulaIcon,
  TrendingUp as RollupIcon,
  LocalShipping as SupplierIcon,
  Inventory2Outlined as ProductIcon,
  Description as DocumentIcon,
  TableRowsOutlined as RecordRefIcon,
  Business as CustomerIcon,
  ViewColumnOutlined as DefaultColumnIcon,
  Inventory2Outlined as ArchiveIcon,
} from '@mui/icons-material';
import type { ReactNode } from 'react';
import type {
  ApiRecordColumn,
  RecordColumnType,
  UpdateColumnRequest,
} from '../../../shared/types';
import { EditColumnDialog } from './EditColumnDialog';
import { AddColumnDialog } from './AddColumnDialog';
import { recordsApi } from '../../lib/recordsApi';

interface ColumnManagerDialogProps {
  open: boolean;
  onClose: () => void;
  columns: ApiRecordColumn[];
  sheetId: string;
  sheetName: string;
  onColumnUpdated: (column: ApiRecordColumn) => void;
  onColumnArchived: (columnId: string) => void;
  onColumnCreated: (column: ApiRecordColumn) => void;
}

const TYPE_LABELS: Record<RecordColumnType, string> = {
  text: 'Text',
  long_text: 'Long text',
  number: 'Number',
  currency: 'Currency',
  percent: 'Percent',
  date: 'Date',
  datetime: 'Date & time',
  duration: 'Duration',
  checkbox: 'Checkbox',
  dropdown_single: 'Dropdown',
  dropdown_multi: 'Multi-select',
  contact: 'Contact',
  email: 'Email',
  url: 'URL',
  phone: 'Phone',
  attachment: 'Attachment',
  formula: 'Formula',
  rollup: 'Rollup',
  supplier_ref: 'Supplier reference',
  product_ref: 'Product reference',
  document_ref: 'Document reference',
  record_ref: 'Record reference',
  customer_ref: 'Customer reference',
};

const TYPE_ICONS: Record<RecordColumnType, ReactNode> = {
  text: <TextIcon fontSize="small" />,
  long_text: <LongTextIcon fontSize="small" />,
  number: <NumberIcon fontSize="small" />,
  currency: <CurrencyIcon fontSize="small" />,
  percent: <PercentIcon fontSize="small" />,
  date: <DateIcon fontSize="small" />,
  datetime: <DateTimeIcon fontSize="small" />,
  duration: <DurationIcon fontSize="small" />,
  checkbox: <CheckboxIcon fontSize="small" />,
  dropdown_single: <DropdownIcon fontSize="small" />,
  dropdown_multi: <MultiSelectIcon fontSize="small" />,
  contact: <ContactIcon fontSize="small" />,
  email: <EmailIcon fontSize="small" />,
  url: <UrlIcon fontSize="small" />,
  phone: <PhoneIcon fontSize="small" />,
  attachment: <AttachmentIcon fontSize="small" />,
  formula: <FormulaIcon fontSize="small" />,
  rollup: <RollupIcon fontSize="small" />,
  supplier_ref: <SupplierIcon fontSize="small" />,
  product_ref: <ProductIcon fontSize="small" />,
  document_ref: <DocumentIcon fontSize="small" />,
  record_ref: <RecordRefIcon fontSize="small" />,
  customer_ref: <CustomerIcon fontSize="small" />,
};

export function ColumnManagerDialog({
  open,
  onClose,
  columns,
  sheetId,
  sheetName,
  onColumnUpdated,
  onColumnArchived,
  onColumnCreated,
}: ColumnManagerDialogProps) {
  const [editTarget, setEditTarget] = useState<ApiRecordColumn | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<ApiRecordColumn | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState('');

  // Active (non-archived) columns only. Incoming `columns` prop may
  // already filter, but we double-check to keep this self-contained.
  const visibleColumns = columns.filter((c) => !c.archived);

  const handleSaveEdit = async (columnId: string, data: UpdateColumnRequest) => {
    const res = await recordsApi.columns.update(sheetId, columnId, data);
    onColumnUpdated(res.column);
  };

  const handleCreate = async (data: Parameters<typeof recordsApi.columns.create>[1]) => {
    const res = await recordsApi.columns.create(sheetId, data);
    onColumnCreated(res.column);
  };

  const confirmArchive = async () => {
    if (!archiveTarget) return;
    setArchiving(true);
    setError('');
    try {
      await recordsApi.columns.archive(sheetId, archiveTarget.id);
      onColumnArchived(archiveTarget.id);
      setArchiveTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive column');
    } finally {
      setArchiving(false);
    }
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Columns in {sheetName}
          </Box>
          <IconButton size="small" onClick={onClose} aria-label="Close">
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          {visibleColumns.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
              No columns yet. Add one below.
            </Typography>
          ) : (
            <Stack divider={<Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }} />}>
              {visibleColumns.map((col) => {
                const type = col.type as RecordColumnType;
                const icon = TYPE_ICONS[type] ?? <DefaultColumnIcon fontSize="small" />;
                const typeLabel = TYPE_LABELS[type] ?? col.type;
                return (
                  <Stack
                    key={col.id}
                    direction="row"
                    alignItems="center"
                    spacing={1.5}
                    sx={{ py: 1.25 }}
                  >
                    <Box sx={{ color: 'text.secondary', display: 'flex', alignItems: 'center' }}>
                      {icon}
                    </Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        variant="body2"
                        sx={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {col.label}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {typeLabel}
                      </Typography>
                    </Box>
                    <Button size="small" onClick={() => setEditTarget(col)}>
                      Edit
                    </Button>
                    <Button
                      size="small"
                      color="warning"
                      onClick={() => setArchiveTarget(col)}
                    >
                      Archive
                    </Button>
                  </Stack>
                );
              })}
            </Stack>
          )}
          {error && (
            <Typography variant="body2" color="error" sx={{ mt: 2 }}>
              {error}
            </Typography>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 1.5, justifyContent: 'space-between' }}>
          <Button startIcon={<AddIcon />} onClick={() => setAddOpen(true)}>
            Add column
          </Button>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Edit column — same dialog the Grid header menu uses. */}
      <EditColumnDialog
        open={Boolean(editTarget)}
        column={editTarget}
        onClose={() => setEditTarget(null)}
        onSave={handleSaveEdit}
      />

      {/* Add column — same dialog the Grid trailing "+" uses. */}
      <AddColumnDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreate={handleCreate}
      />

      {/* Archive confirm */}
      <Dialog
        open={Boolean(archiveTarget)}
        onClose={() => !archiving && setArchiveTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ArchiveIcon fontSize="small" />
          Archive this column?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            <strong>{archiveTarget?.label}</strong> will be hidden from views and forms. Cell data is preserved and can be restored later.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setArchiveTarget(null)} disabled={archiving}>
            Cancel
          </Button>
          <Button
            color="warning"
            variant="contained"
            onClick={confirmArchive}
            disabled={archiving}
          >
            {archiving ? 'Archiving…' : 'Archive'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
