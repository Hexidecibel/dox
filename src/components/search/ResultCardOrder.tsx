import { Box, Card, CardContent, Chip, Stack, Typography } from '@mui/material';
import ReceiptIcon from '@mui/icons-material/Receipt';
import { useNavigate } from 'react-router-dom';
import { Snippet } from './Snippet';
import type { UniversalSearchOrder } from '../../../shared/types';

export interface ResultCardOrderProps {
  order: UniversalSearchOrder;
  onOpen?: (order: UniversalSearchOrder) => void;
}

export function ResultCardOrder({ order, onOpen }: ResultCardOrderProps) {
  const navigate = useNavigate();
  const open = () => (onOpen ? onOpen(order) : navigate(`/orders/${order.id}`));
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
          <ReceiptIcon sx={{ color: 'secondary.main', mt: 0.25, fontSize: '1.1rem' }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }} noWrap>
              {order.order_number ?? order.id}
              {order.po_number ? <span style={{ color: '#888' }}> · PO {order.po_number}</span> : null}
            </Typography>
            {order.customer_name && (
              <Typography variant="body2" color="text.secondary" noWrap>
                Customer: {order.customer_name}
              </Typography>
            )}
            {order.snippet && (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mt: 0.5 }}
              >
                <Snippet text={order.snippet} />
              </Typography>
            )}
            <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }} useFlexGap>
              <Chip size="small" label="Order" variant="outlined" />
            </Stack>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}
