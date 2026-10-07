/**
 * Product > Brand and producer (migrations 0078 and 0135).
 *
 * `brand_owner`, `producer` and `plant_code` have been on the product and
 * accepted by the API since 0078, and no screen ever showed or edited them.
 * This is that screen, plus the one thing the three fields are for: when a
 * brand owner and a producer are both recorded and differ, the item is
 * private label. That is a label -- nothing in the portal is blocked by it --
 * and one of the two being blank is "not known", not private label.
 *
 * Below it, read-only: every supplier this item comes from, with its approval
 * and facility. Those are decided per supplier, on the Approved items page or
 * the supplier's Products tab.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { api } from '../lib/api';
import { ItemApprovalChip } from './ItemApproval';
import { isPrivateLabel } from '../../shared/itemApproval';
import type { ApiProduct } from '../lib/types';
import type { ApprovedItem } from '../../shared/types';

interface Props {
  product: ApiProduct;
  canEdit: boolean;
  onSaved: (product: ApiProduct) => void;
}

export default function ProductAttributionPanel({ product, canEdit, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [brandOwner, setBrandOwner] = useState(product.brand_owner ?? '');
  const [producer, setProducer] = useState(product.producer ?? '');
  const [plantCode, setPlantCode] = useState(product.plant_code ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [pairs, setPairs] = useState<ApprovedItem[] | null>(null);

  const reset = useCallback(() => {
    setBrandOwner(product.brand_owner ?? '');
    setProducer(product.producer ?? '');
    setPlantCode(product.plant_code ?? '');
  }, [product.brand_owner, product.producer, product.plant_code]);

  useEffect(() => {
    reset();
  }, [reset]);

  useEffect(() => {
    let live = true;
    api.approvedItems
      .list({ product_id: product.id, tenant_id: product.tenant_id, limit: 200 })
      .then((res) => {
        if (live) setPairs(res.items);
      })
      .catch(() => {
        // An addition to the page: a failed read leaves the section out.
        if (live) setPairs([]);
      });
    return () => {
      live = false;
    };
  }, [product.id, product.tenant_id]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const result = await api.products.update(product.id, {
        brand_owner: brandOwner.trim() || null,
        producer: producer.trim() || null,
        plant_code: plantCode.trim() || null,
      });
      onSaved(result.product);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const privateLabel = isPrivateLabel(product.brand_owner, product.producer);

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }} data-testid="product-attribution">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="subtitle2" color="text.secondary" sx={{ flexGrow: 1 }}>
          Brand and producer
        </Typography>
        {privateLabel && (
          <Tooltip title="The brand owner and the producer are different companies. A label only: it changes nothing else.">
            <Chip size="small" color="info" variant="outlined" label="Private label" data-testid="private-label-chip" />
          </Tooltip>
        )}
        {canEdit && !editing && (
          <Button size="small" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {editing ? (
        <Stack spacing={2}>
          <TextField
            label="Brand owner"
            size="small"
            value={brandOwner}
            onChange={(e) => setBrandOwner(e.target.value)}
            helperText="The company whose name is on the label."
            disabled={saving}
            fullWidth
          />
          <TextField
            label="Producer"
            size="small"
            value={producer}
            onChange={(e) => setProducer(e.target.value)}
            helperText="The company that makes it. When this differs from the brand owner the item is marked private label."
            disabled={saving}
            fullWidth
          />
          <TextField
            label="Plant code"
            size="small"
            value={plantCode}
            onChange={(e) => setPlantCode(e.target.value)}
            helperText="Optional. The plant or establishment code printed on the product."
            disabled={saving}
            fullWidth
          />
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button variant="contained" size="small" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
            <Button
              size="small"
              disabled={saving}
              onClick={() => {
                reset();
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </Box>
        </Stack>
      ) : (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 1, sm: 4 }}>
          <Field label="Brand owner" value={product.brand_owner} />
          <Field label="Producer" value={product.producer} />
          <Field label="Plant code" value={product.plant_code} />
        </Stack>
      )}

      {pairs && pairs.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            Suppliers of this item
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Supplier</TableCell>
                <TableCell>Facility</TableCell>
                <TableCell>Approval</TableCell>
                <TableCell>Supplied</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pairs.map((p) => (
                <TableRow key={p.supplier_id}>
                  <TableCell>
                    <Link component={RouterLink} to={`/admin/suppliers/${p.supplier_id}`} underline="hover">
                      {p.supplier_name}
                    </Link>
                  </TableCell>
                  <TableCell>{p.facility?.name ?? 'No facility recorded'}</TableCell>
                  <TableCell>
                    <ItemApprovalChip status={p.approval_status} source={p.approval_source} note={p.approval_note} />
                  </TableCell>
                  <TableCell>{p.supplied ? 'Currently supplied' : 'No longer supplied'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </Paper>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" display="block">
        {label}
      </Typography>
      <Typography variant="body2">{value || 'Not recorded'}</Typography>
    </Box>
  );
}
