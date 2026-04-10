import type { ConnectorExecuteFn, ConnectorOutput, ConnectorContext, ConnectorInput, ParsedOrder, ParsedCustomer, EmailAttachment } from './types';

/**
 * Email connector: parses inbound emails into orders and customers.
 * Supports plain text, HTML, and CSV/structured attachments.
 * Uses Qwen AI for unstructured text, direct parsing for CSV.
 */
export const execute: ConnectorExecuteFn = async (ctx, input) => {
  if (input.type !== 'email') {
    return { orders: [], customers: [], errors: [{ message: 'Expected email input' }] };
  }

  const { body, html, subject, sender, attachments } = input;

  // Priority: structured attachments > HTML > plain text
  const csvAttachment = attachments?.find(a =>
    a.contentType === 'text/csv' ||
    a.filename.endsWith('.csv') ||
    a.filename.endsWith('.tsv')
  );

  if (csvAttachment) {
    return parseCSVAttachment(ctx, csvAttachment);
  }

  // For text/HTML, use AI extraction
  const textContent = body || stripHtml(html || '');
  if (!textContent.trim()) {
    return { orders: [], customers: [], errors: [{ message: 'Empty email body' }] };
  }

  return parseWithAI(ctx, textContent, subject);
};

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<(?:td|th)[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseCSVAttachment(ctx: ConnectorContext, attachment: EmailAttachment): ConnectorOutput {
  const decoder = new TextDecoder();
  const text = decoder.decode(attachment.content);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  if (lines.length < 2) {
    return { orders: [], customers: [], errors: [{ message: 'CSV has no data rows' }] };
  }

  const delimiter = text.includes('\t') ? '\t' : ',';
  const headers = lines[0].split(delimiter).map(h => h.trim().toLowerCase().replace(/^["']|["']$/g, ''));
  const fieldMappings = ctx.fieldMappings || {};

  const orders: ParsedOrder[] = [];
  const customers: ParsedCustomer[] = [];
  const errors: { record_index?: number; field?: string; message: string }[] = [];
  const seenCustomers = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(delimiter).map(v => v.trim().replace(/^["']|["']$/g, ''));
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });

    // Apply field mappings: map source column names to standard fields
    const mapped: Record<string, string> = {};
    for (const [sourceField, targetField] of Object.entries(fieldMappings)) {
      if (row[sourceField.toLowerCase()] !== undefined) {
        mapped[targetField] = row[sourceField.toLowerCase()];
      }
    }

    // Fallback to common column names if no mapping
    const orderNumber = mapped['order_number'] || row['order_number'] || row['order'] || row['order_no'] || row['ordernumber'];
    const customerNumber = mapped['customer_number'] || row['customer_number'] || row['customer'] || row['customer_no'] || row['cust_no'];
    const customerName = mapped['customer_name'] || row['customer_name'] || row['name'] || row['business_name'];

    if (!orderNumber) {
      errors.push({ record_index: i, message: 'Missing order number' });
      continue;
    }

    orders.push({
      order_number: orderNumber,
      po_number: mapped['po_number'] || row['po_number'] || row['po'] || undefined,
      customer_number: customerNumber || undefined,
      customer_name: customerName || undefined,
      items: [],
      source_data: row,
    });

    if (customerNumber && !seenCustomers.has(customerNumber)) {
      seenCustomers.add(customerNumber);
      customers.push({
        customer_number: customerNumber,
        name: customerName || customerNumber,
        email: row['email'] || row['customer_email'] || undefined,
      });
    }
  }

  return { orders, customers, errors };
}

async function parseWithAI(
  ctx: ConnectorContext,
  text: string,
  subject: string
): Promise<ConnectorOutput> {
  const config = ctx.config as Record<string, unknown>;
  const parsingPrompt = (config.parsing_prompt as string) || getDefaultParsingPrompt();

  if (!ctx.qwenUrl) {
    return { orders: [], customers: [], errors: [{ message: 'AI extraction not configured (QWEN_URL missing)' }] };
  }

  // Trim to avoid token limits
  const trimmedText = text.slice(0, 8000);

  const messages = [
    {
      role: 'system' as const,
      content: parsingPrompt,
    },
    {
      role: 'user' as const,
      content: `Subject: ${subject}\n\n${trimmedText}`,
    },
  ];

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ctx.qwenSecret) {
      headers['Authorization'] = `Bearer ${ctx.qwenSecret}`;
    }

    const response = await fetch(`${ctx.qwenUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'qwen',
        messages,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      return { orders: [], customers: [], errors: [{ message: `AI extraction failed: ${response.status}` }] };
    }

    const result = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = result.choices?.[0]?.message?.content;
    if (!content) {
      return { orders: [], customers: [], errors: [{ message: 'AI returned empty response' }] };
    }

    const parsed = JSON.parse(content) as {
      orders?: Array<{
        order_number: string;
        po_number?: string;
        customer_number?: string;
        customer_name?: string;
        items?: Array<{
          product_name?: string;
          product_code?: string;
          quantity?: number;
          lot_number?: string;
        }>;
      }>;
    };

    const orders: ParsedOrder[] = (parsed.orders || []).map(o => ({
      order_number: o.order_number,
      po_number: o.po_number,
      customer_number: o.customer_number,
      customer_name: o.customer_name,
      items: (o.items || []).map(item => ({
        product_name: item.product_name,
        product_code: item.product_code,
        quantity: item.quantity,
        lot_number: item.lot_number,
      })),
      source_data: o as Record<string, unknown>,
    }));

    // Extract unique customers
    const seenCustomers = new Set<string>();
    const customers: ParsedCustomer[] = [];
    for (const o of orders) {
      if (o.customer_number && !seenCustomers.has(o.customer_number)) {
        seenCustomers.add(o.customer_number);
        customers.push({
          customer_number: o.customer_number,
          name: o.customer_name || o.customer_number,
        });
      }
    }

    return { orders, customers, errors: [] };
  } catch (err) {
    return {
      orders: [],
      customers: [],
      errors: [{ message: `AI parsing error: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
}

function getDefaultParsingPrompt(): string {
  return `You are an ERP report parser. Extract order and customer data from the email.

Return JSON in this exact format:
{
  "orders": [
    {
      "order_number": "string (required)",
      "po_number": "string or null",
      "customer_number": "string (e.g. K00123 or P000456)",
      "customer_name": "string",
      "items": [
        {
          "product_name": "string or null",
          "product_code": "string or null",
          "quantity": number or null,
          "lot_number": "string or null"
        }
      ]
    }
  ]
}

Rules:
- Extract ALL orders from the email
- customer_number formats: K##### or P###### (preserve exact format)
- If no line items are visible, return empty items array
- If a field is not present, omit it or set to null
- Return valid JSON only, no explanation`;
}
