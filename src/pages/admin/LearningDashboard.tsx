import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  Paper,
  CircularProgress,
  Alert,
  Card,
  CardContent,
} from '@mui/material';
import { AUTH_TOKEN_KEY } from '../../lib/types';
import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';

interface WeeklyOverrideRow {
  week_start: string;
  total_approves: number;
  approves_with_overrides: number;
  rate: number;
}

interface WeeklyBurdenRow {
  week_start: string;
  median_seconds_per_approve: number | null;
}

interface SupplierVolumeRow {
  supplier_id: string;
  supplier_name: string | null;
  pick_count: number;
}

interface DashboardResponse {
  override_rate_weekly: WeeklyOverrideRow[];
  review_burden_weekly: WeeklyBurdenRow[];
  trust_distribution: unknown[];
  recent_demotions: unknown[];
  pick_volume_by_supplier: SupplierVolumeRow[];
}

/**
 * Inline SVG line chart. Avoids pulling in a chart library for what is one
 * trend per panel. Renders the most-recent point on the right edge.
 */
function LineChart({
  points,
  height = 160,
  yMax,
  yLabel,
  xLabels,
  color = '#1976d2',
}: {
  points: number[];
  height?: number;
  yMax?: number;
  yLabel?: string;
  xLabels?: string[];
  color?: string;
}) {
  if (points.length === 0) {
    return <Typography variant="body2" color="text.secondary">No data</Typography>;
  }
  const width = 600;
  const padX = 30;
  const padY = 20;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const max = yMax ?? Math.max(1, ...points);
  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const xy = points.map((v, i) => [
    padX + i * stepX,
    padY + innerH - (v / max) * innerH,
  ] as [number, number]);
  const path = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height }} role="img" aria-label={yLabel}>
      <line x1={padX} y1={padY} x2={padX} y2={padY + innerH} stroke="#ccc" strokeWidth="1" />
      <line x1={padX} y1={padY + innerH} x2={padX + innerW} y2={padY + innerH} stroke="#ccc" strokeWidth="1" />
      <text x={padX - 4} y={padY + 4} textAnchor="end" fontSize="10" fill="#666">{max.toFixed(2)}</text>
      <text x={padX - 4} y={padY + innerH} textAnchor="end" fontSize="10" fill="#666">0</text>
      <path d={path} fill="none" stroke={color} strokeWidth="2" />
      {xy.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={3} fill={color} />
      ))}
      {xLabels && xLabels.length === points.length && (
        <>
          {xLabels.map((label, i) => {
            if (i % Math.ceil(xLabels.length / 6) !== 0 && i !== xLabels.length - 1) return null;
            const x = padX + i * stepX;
            return (
              <text key={i} x={x} y={height - 4} textAnchor="middle" fontSize="9" fill="#666">
                {label.slice(5)}
              </text>
            );
          })}
        </>
      )}
    </svg>
  );
}

/**
 * Inline horizontal bar chart for top-N suppliers. Bar width is normalized
 * against the max pick_count in the input set.
 */
function BarChart({ rows }: { rows: SupplierVolumeRow[] }) {
  if (rows.length === 0) {
    return <Typography variant="body2" color="text.secondary">No picks yet this month</Typography>;
  }
  const max = Math.max(1, ...rows.map(r => r.pick_count));
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {rows.map(r => {
        const pct = (r.pick_count / max) * 100;
        return (
          <Box key={r.supplier_id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="caption" sx={{ minWidth: 160, flexShrink: 0 }}>
              {r.supplier_name ?? r.supplier_id.slice(0, 8)}
            </Typography>
            <Box sx={{ flex: 1, position: 'relative', height: 16, bgcolor: '#f0f0f0', borderRadius: 0.5 }}>
              <Box sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, bgcolor: 'primary.main', borderRadius: 0.5 }} />
            </Box>
            <Typography variant="caption" sx={{ minWidth: 36, textAlign: 'right' }}>
              {r.pick_count}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

export default function LearningDashboard() {
  const { isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      const params = new URLSearchParams();
      if (isSuperAdmin && selectedTenantId) params.set('tenant_id', selectedTenantId);
      const qs = params.toString();
      const res = await fetch(`/api/admin/learning-dashboard${qs ? `?${qs}` : ''}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as DashboardResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin, selectedTenantId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}><CircularProgress /></Box>;
  }
  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }
  if (!data) return null;

  const overridePoints = data.override_rate_weekly.map(r => r.rate);
  const overrideLabels = data.override_rate_weekly.map(r => r.week_start);
  const burdenPoints = data.review_burden_weekly.map(r => r.median_seconds_per_approve ?? 0);
  const burdenLabels = data.review_burden_weekly.map(r => r.week_start);
  const totalApproves = data.override_rate_weekly.reduce((s, r) => s + r.total_approves, 0);
  const totalOverrides = data.override_rate_weekly.reduce((s, r) => s + r.approves_with_overrides, 0);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box>
        <Typography variant="h5" gutterBottom>Learning Dashboard</Typography>
        <Typography variant="body2" color="text.secondary">
          Tracking signal from reviewer decisions. Trends below should improve as the model learns.
        </Typography>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
        <Paper sx={{ p: 2 }}>
          <Box sx={{ mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={600}>Override rate</Typography>
            <Typography variant="caption" color="text.secondary">
              % of approves with at least one reviewer edit or dismissal — last {data.override_rate_weekly.length} weeks.
              Trending down = the model is matching reviewer expectations more often.
            </Typography>
          </Box>
          <LineChart points={overridePoints} yMax={1} yLabel="Override rate" xLabels={overrideLabels} color="#d32f2f" />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {totalOverrides} of {totalApproves} approves had overrides
            {totalApproves > 0 ? ` (${Math.round((totalOverrides / totalApproves) * 100)}% overall)` : ''}.
          </Typography>
        </Paper>

        <Paper sx={{ p: 2 }}>
          <Box sx={{ mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={600}>Review burden</Typography>
            <Typography variant="caption" color="text.secondary">
              Median seconds from queue arrival → approve. Should drop as trust in the model increases.
            </Typography>
          </Box>
          <LineChart points={burdenPoints} yLabel="Seconds" xLabels={burdenLabels} color="#0288d1" />
        </Paper>

        <Paper sx={{ p: 2 }}>
          <Box sx={{ mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={600}>Trust distribution</Typography>
            <Typography variant="caption" color="text.secondary">
              Per-(supplier, doctype) trust state — manual / pre-fill / silent / auto.
            </Typography>
          </Box>
          <Card variant="outlined" sx={{ bgcolor: '#fafafa' }}>
            <CardContent>
              <Typography variant="body2" color="text.secondary">
                Trust ladder not yet enabled — Phase 3b. Once the override-rate trend at left
                shows learning is working, the trust ladder will graduate suppliers from
                pre-fill into silent-apply and finally auto-ingest.
              </Typography>
            </CardContent>
          </Card>
        </Paper>

        <Paper sx={{ p: 2 }}>
          <Box sx={{ mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={600}>Top suppliers (this month)</Typography>
            <Typography variant="caption" color="text.secondary">
              By volume of reviewer field picks captured. High volume → fastest learning.
            </Typography>
          </Box>
          <BarChart rows={data.pick_volume_by_supplier} />
        </Paper>
      </Box>
    </Box>
  );
}
