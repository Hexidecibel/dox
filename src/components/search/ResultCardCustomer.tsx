import { Box, Card, CardContent, Chip, Stack, Typography } from '@mui/material';
import PersonIcon from '@mui/icons-material/Person';
import { useNavigate } from 'react-router-dom';
import { Snippet } from './Snippet';
import type { UniversalSearchCustomer } from '../../../shared/types';

export interface ResultCardCustomerProps {
  customer: UniversalSearchCustomer;
  onOpen?: (customer: UniversalSearchCustomer) => void;
}

export function ResultCardCustomer({ customer, onOpen }: ResultCardCustomerProps) {
  const navigate = useNavigate();
  const open = () =>
    onOpen ? onOpen(customer) : navigate(`/customers/${customer.id}`);
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
          <PersonIcon sx={{ color: 'info.main', mt: 0.25, fontSize: '1.1rem' }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }} noWrap>
              <Snippet text={customer.name} />
            </Typography>
            {customer.customer_number && (
              <Typography variant="caption" color="text.secondary">
                #{customer.customer_number}
              </Typography>
            )}
            <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }} useFlexGap>
              <Chip size="small" label="Customer" variant="outlined" />
            </Stack>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}
