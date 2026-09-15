/**
 * Supplier Requirements — the cross-supplier roster of "who has a checklist at
 * all", with the per-supplier editor opening inline underneath.
 *
 * WHY THIS EXISTS ALONGSIDE THE SUPPLIER-DETAIL TAB. The editor itself
 * (`SupplierRequirementsEditor`) is mounted in two places on purpose, and they
 * answer different questions:
 *
 *   SupplierDetail → Requirements   "I am looking at Acme. Fix Acme."
 *   here                            "Which of my ninety suppliers has nobody
 *                                    ever configured?"
 *
 * The second question is the one that cannot be answered by visiting supplier
 * pages, because the failure is INVISIBLE from any single one of them: a
 * supplier with no applicability rows produces no gaps, so it never appears in
 * a gap report, so nothing draws you to its page. The roster is the only
 * surface where "nobody set this up" is a row you can see. That is the same
 * argument `ClaimRules` makes for sorting unconfigured claims to the top, and
 * this page follows it: unconfigured suppliers first, flagged, with a progress
 * line that makes the remaining work finite.
 *
 * There is one editor component, not two implementations.
 *
 * REQUIREMENTS FROM REAL DATA (0111). Two more tabs sit beside the roster:
 * "Needs review" — rows the initial bulk seed wrote that nobody confirmed, and
 * derived rows the verified supplier list stopped supporting — and "Import
 * verified supplier list", the spreadsheet door to the one derivation rule. The
 * roster itself can select suppliers and apply a requirement packet to them,
 * preview first.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Collapse,
  LinearProgress,
  Link,
  Paper,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import {
  ExpandLess as CollapseIcon,
  ExpandMore as ExpandIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import type { ApiSupplier, ApiSupplierRequirement } from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { HelpWell } from '../../components/HelpWell';
import { EmptyState } from '../../components/EmptyState';
import SupplierRequirementsEditor, {
  tierCounts,
} from '../../components/SupplierRequirementsEditor';
import ApplyPacketDialog from '../../components/ApplyPacketDialog';
import RequirementsWorklist from '../../components/RequirementsWorklist';
import SupplierListImport from '../../components/SupplierListImport';

export function SupplierRequirements() {
  const [suppliers, setSuppliers] = useState<ApiSupplier[]>([]);
  const [rows, setRows] = useState<ApiSupplierRequirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [packetOpen, setPacketOpen] = useState(false);
  const [notice, setNotice] = useState('');

  const navigate = useNavigate();
  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();

  const tenantId = isSuperAdmin ? selectedTenantId || undefined : user?.tenant_id || undefined;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [supplierRes, requirementRows] = await Promise.all([
        api.suppliers.list({ active: 1, limit: 500, tenant_id: tenantId }),
        api.supplierRequirements.listAll({ tenant_id: tenantId }),
      ]);
      setSuppliers(supplierRes.suppliers);
      setRows(requirementRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load supplier requirements');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  /** supplier_id -> its attached rows. Absent key means nobody configured it. */
  const bySupplier = useMemo(() => {
    const map = new Map<string, ApiSupplierRequirement[]>();
    for (const row of rows) {
      const bucket = map.get(row.supplier_id);
      if (bucket) bucket.push(row);
      else map.set(row.supplier_id, [row]);
    }
    return map;
  }, [rows]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = needle
      ? suppliers.filter((s) => s.name.toLowerCase().includes(needle))
      : suppliers;
    // Unconfigured first — that is the work queue — then alphabetical.
    return [...matched].sort((a, b) => {
      const aHas = bySupplier.has(a.id) ? 1 : 0;
      const bHas = bySupplier.has(b.id) ? 1 : 0;
      if (aHas !== bHas) return aHas - bHas;
      return a.name.localeCompare(b.name);
    });
  }, [suppliers, bySupplier, filter]);

  const needsReview = useMemo(
    () => rows.filter((r) => r.source === null || r.source === undefined || !!r.review_flag).length,
    [rows],
  );
  const pickedSuppliers = suppliers.filter((s) => picked.has(s.id)).map((s) => ({ id: s.id, name: s.name }));

  const configured = suppliers.filter((s) => bySupplier.has(s.id)).length;
  const pct = suppliers.length ? Math.round((configured / suppliers.length) * 100) : 0;

  if (loading && suppliers.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h4" fontWeight={700} sx={{ mb: 3 }}>
        Supplier Requirements
      </Typography>

      <HelpWell id="registry.supplier_requirements" title="What does each supplier owe us?">
        Attach requirements to a supplier and the gap report can tell you what is missing.{' '}
        <strong>Required</strong> items are counted as gaps; <strong>recommended</strong> ones are
        advisory and left out by default — that default exists so the report stays worth reading.
        A supplier with nothing attached is <strong>not set up</strong>, which is not the same as
        having nothing outstanding: nothing is being checked for them at all.
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {notice && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      )}

      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }} variant="scrollable" scrollButtons="auto">
        <Tab label="Suppliers" />
        <Tab
          label={
            <Badge color="warning" badgeContent={needsReview} max={999} sx={{ pr: needsReview ? 2 : 0 }}>
              Needs review
            </Badge>
          }
        />
        <Tab label="Import verified supplier list" />
      </Tabs>

      {tab === 1 && <RequirementsWorklist tenantId={tenantId} onChanged={load} />}
      {tab === 2 && <SupplierListImport tenantId={tenantId} onApplied={load} />}

      {tab !== 0 ? null : suppliers.length === 0 ? (
        <EmptyState
          title="No suppliers yet"
          description="Requirements attach to a supplier, so add a supplier first."
          actionLabel="Go to suppliers"
          onAction={() => navigate('/admin/suppliers')}
        />
      ) : (
        <>
          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="body2" fontWeight={600}>
                {configured} of {suppliers.length} suppliers have requirements attached
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {pct}%
              </Typography>
            </Box>
            <LinearProgress variant="determinate" value={pct} />
            {configured < suppliers.length && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                Suppliers with nothing set up are listed first. Until one has requirements
                attached, nothing is ever reported as missing for them.
              </Typography>
            )}
          </Paper>

          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mb: 2 }}>
            <TextField
              size="small"
              placeholder="Filter suppliers"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              sx={{ flexGrow: 1, minWidth: 200 }}
            />
            <Button
              size="small"
              onClick={() => setPicked(picked.size === visible.length ? new Set() : new Set(visible.map((s) => s.id)))}
            >
              {picked.size === visible.length && visible.length > 0 ? 'Clear selection' : 'Select shown'}
            </Button>
            <Button
              size="small"
              variant="contained"
              disabled={picked.size === 0}
              onClick={() => setPacketOpen(true)}
            >
              Apply packet to {picked.size || ''} selected
            </Button>
          </Box>

          <ApplyPacketDialog
            open={packetOpen}
            onClose={() => setPacketOpen(false)}
            suppliers={pickedSuppliers}
            tenantId={tenantId}
            onApplied={(res) => {
              setNotice(
                `${res.packet_name} applied to ${res.suppliers.length} supplier${res.suppliers.length === 1 ? '' : 's'}: ${res.totals.add} added, ${res.totals.adopt_unconfirmed} unconfirmed confirmed, ${res.totals.remove_unconfirmed} removed.`,
              );
              setPicked(new Set());
              void load();
            }}
          />

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {visible.map((supplier) => {
              const attached = bySupplier.get(supplier.id);
              const unconfigured = !attached;
              const counts = tierCounts(attached ?? []);
              const unconfirmed = (attached ?? []).filter(
                (r) => r.source === null || r.source === undefined || !!r.review_flag,
              ).length;
              const open = openId === supplier.id;
              return (
                <Paper
                  key={supplier.id}
                  variant="outlined"
                  sx={{ p: 2, borderColor: unconfigured ? 'warning.main' : undefined }}
                >
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1.5,
                      flexWrap: 'wrap',
                      cursor: 'pointer',
                    }}
                    onClick={() => setOpenId(open ? null : supplier.id)}
                  >
                    <Checkbox
                      size="small"
                      checked={picked.has(supplier.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(supplier.id);
                          else next.delete(supplier.id);
                          return next;
                        })
                      }
                      inputProps={{ 'aria-label': `Select ${supplier.name}` }}
                    />
                    <Box sx={{ minWidth: 200 }}>
                      <Typography variant="body1" fontWeight={700}>
                        {supplier.name}
                      </Typography>
                    </Box>

                    <Box sx={{ flexGrow: 1 }}>
                      {unconfigured ? (
                        <Typography variant="body2" color="warning.main" fontWeight={600}>
                          Nothing set up yet — nothing is being checked for this supplier
                        </Typography>
                      ) : (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                          <Typography variant="body2" color="text.secondary">
                            must provide
                          </Typography>
                          <Chip size="small" color="primary" label={`${counts.required} required`} />
                          {counts.recommended > 0 && (
                            <Chip
                              size="small"
                              variant="outlined"
                              label={`${counts.recommended} recommended`}
                            />
                          )}
                          {unconfirmed > 0 && (
                            <Chip
                              size="small"
                              color="warning"
                              variant="outlined"
                              label={`${unconfirmed} need review`}
                            />
                          )}
                        </Box>
                      )}
                    </Box>

                    <Link
                      component="button"
                      variant="body2"
                      underline="hover"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/admin/suppliers/${supplier.id}`);
                      }}
                    >
                      Open supplier
                    </Link>

                    {open ? <CollapseIcon color="action" /> : <ExpandIcon color="action" />}
                  </Box>

                  <Collapse in={open} unmountOnExit>
                    <Box sx={{ pt: 2 }}>
                      <SupplierRequirementsEditor
                        supplierId={supplier.id}
                        supplierName={supplier.name}
                        tenantId={tenantId}
                        onChanged={load}
                      />
                    </Box>
                  </Collapse>
                </Paper>
              );
            })}
          </Box>
        </>
      )}
    </Box>
  );
}

export default SupplierRequirements;
