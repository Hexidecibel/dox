# Phase 2 Test Plan: Connector System End-to-End

Testing the universal connector system, order pipeline, and customer registry.

**Prerequisites:**
- Dev server running at `localhost:8788` (`npm run dev`)
- Seeded admin user exists (run `./bin/seed` if needed)
- Tenant exists (the seed creates one)

---

## 0. Get Auth Token

All API calls require a JWT token. Get one first:

```bash
# Login and capture token
TOKEN=$(curl -s http://localhost:8788/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"admin123"}' \
  | jq -r '.token')

echo $TOKEN

# Also grab the tenant_id from the login response
TENANT_ID=$(curl -s http://localhost:8788/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"admin123"}' \
  | jq -r '.user.tenant_id')

echo $TENANT_ID
```

> Adjust email/password to match your seed user. If using the UI, grab the token from browser DevTools (Application > Local Storage > `token`).

---

## 1. API Tests (curl)

### 1.1 Customers CRUD

#### Create a customer

```bash
curl -s http://localhost:8788/api/customers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "customer_number": "K00123",
    "name": "Kraft Heinz - Chicago",
    "email": "purchasing@kraftheinz.example.com",
    "coa_delivery_method": "email",
    "coa_requirements": {"format": "pdf", "include_lot": true},
    "tenant_id": "'"$TENANT_ID"'"
  }' | jq .

# Save the ID
CUSTOMER_ID=$(curl -s http://localhost:8788/api/customers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "customer_number": "P000456",
    "name": "PepsiCo Frito-Lay",
    "email": "qa@pepsico.example.com",
    "coa_delivery_method": "email",
    "tenant_id": "'"$TENANT_ID"'"
  }' | jq -r '.customer.id')

echo "Created customer: $CUSTOMER_ID"
```

**Expected:** 201, response contains `customer` object with generated `id`, `created_at`, `active: 1`.

#### List customers

```bash
curl -s "http://localhost:8788/api/customers?tenant_id=$TENANT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** 200, `customers` array with both customers, `total: 2`.

#### List with search

```bash
curl -s "http://localhost:8788/api/customers?tenant_id=$TENANT_ID&search=Kraft" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** Only "Kraft Heinz - Chicago" returned.

#### Get customer by ID

```bash
curl -s "http://localhost:8788/api/customers/$CUSTOMER_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** 200, customer object with `order_count` field (should be 0 initially).

#### Lookup by customer_number

```bash
curl -s "http://localhost:8788/api/customers/lookup?customer_number=K00123&tenant_id=$TENANT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** 200, returns the Kraft customer. `coa_requirements` should be parsed JSON (not a string).

#### Lookup non-existent customer_number

```bash
curl -s "http://localhost:8788/api/customers/lookup?customer_number=NOPE&tenant_id=$TENANT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** 404, `{"error": "Customer not found"}`.

#### Update customer

```bash
curl -s -X PUT "http://localhost:8788/api/customers/$CUSTOMER_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "PepsiCo Frito-Lay - Dallas",
    "email": "qa-team@pepsico.example.com"
  }' | jq .
```

**Expected:** 200, updated customer with new name and email, `updated_at` changed.

#### Delete (soft-delete)

```bash
curl -s -X DELETE "http://localhost:8788/api/customers/$CUSTOMER_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** 200, `{"success": true}`.

#### Verify soft-delete

```bash
# Default list should NOT include the deleted customer
curl -s "http://localhost:8788/api/customers?tenant_id=$TENANT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq '.total'

# With active=0, should show deleted ones
curl -s "http://localhost:8788/api/customers?tenant_id=$TENANT_ID&active=0" \
  -H "Authorization: Bearer $TOKEN" | jq '.customers[].name'
```

**Expected:** Default list excludes soft-deleted. `active=0` filter returns them.

---

### 1.2 Orders CRUD

#### Create an order with items

```bash
curl -s http://localhost:8788/api/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "order_number": "SO-2026-0001",
    "po_number": "PO-88812",
    "customer_name": "Kraft Heinz - Chicago",
    "customer_number": "K00123",
    "tenant_id": "'"$TENANT_ID"'",
    "items": [
      {"product_name": "Vanilla Extract 4x", "product_code": "VE-4X", "quantity": 500, "lot_number": "L2026-0412"},
      {"product_name": "Cinnamon Ground #1", "product_code": "CG-01", "quantity": 200}
    ]
  }' | jq .

ORDER_ID=$(!! | jq -r '.order.id')
echo "Created order: $ORDER_ID"
```

**Expected:** 201, order with `status: "pending"`, items created separately.

#### Create a second order (no items)

```bash
curl -s http://localhost:8788/api/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "order_number": "SO-2026-0002",
    "customer_name": "PepsiCo Frito-Lay",
    "customer_number": "P000456",
    "tenant_id": "'"$TENANT_ID"'"
  }' | jq .
```

#### List orders

```bash
curl -s "http://localhost:8788/api/orders?tenant_id=$TENANT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** 200, both orders. Each has `item_count`, `matched_count`, `connector_name`, `customer_name_resolved`.

#### List with status filter

```bash
curl -s "http://localhost:8788/api/orders?tenant_id=$TENANT_ID&status=pending" \
  -H "Authorization: Bearer $TOKEN" | jq '.total'
```

**Expected:** Shows only pending orders.

#### Get order detail

```bash
curl -s "http://localhost:8788/api/orders/$ORDER_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** 200, `order` object + `items` array with 2 items. Items include `product_name`, `product_code`, `quantity`, `lot_number`.

#### Update order status

```bash
curl -s -X PUT "http://localhost:8788/api/orders/$ORDER_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "enriched"}' | jq .
```

**Expected:** 200, order with `status: "enriched"`, `updated_at` changed.

#### Update with invalid status

```bash
curl -s -X PUT "http://localhost:8788/api/orders/$ORDER_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "invalid_status"}' | jq .
```

**Expected:** 400, error listing valid statuses: `pending, enriched, matched, fulfilled, delivered, error`.

#### Delete order

```bash
curl -s -X DELETE "http://localhost:8788/api/orders/$ORDER_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** 200, `{"success": true}`. This is a hard delete (cascade removes items).

#### Verify hard delete

```bash
curl -s "http://localhost:8788/api/orders/$ORDER_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** 404, `{"error": "Order not found"}`.

---

### 1.3 Connectors CRUD

#### Create an email connector

```bash
curl -s http://localhost:8788/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily ERP Order Report",
    "connector_type": "email",
    "system_type": "erp",
    "config": {
      "subject_patterns": ["Daily COA Report", "COA Requirements"],
      "sender_filter": "erp-reports@company.example.com"
    },
    "field_mappings": {
      "order_number": "order_number",
      "customer_number": "customer_number",
      "customer_name": "customer_name"
    },
    "tenant_id": "'"$TENANT_ID"'"
  }' | jq .

CONNECTOR_ID=$(!! | jq -r '.connector.id')
echo "Created connector: $CONNECTOR_ID"
```

**Expected:** 201, connector with `active: 1`, `has_credentials: false` (no credentials set), `connector_type: "email"`, `system_type: "erp"`.

#### Create with invalid connector_type

```bash
curl -s http://localhost:8788/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Bad Connector",
    "connector_type": "ftp",
    "tenant_id": "'"$TENANT_ID"'"
  }' | jq .
```

**Expected:** 400, error: `connector_type must be one of: email, api_poll, webhook, file_watch`.

#### List connectors

```bash
curl -s "http://localhost:8788/api/connectors?tenant_id=$TENANT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** 200, `connectors` array. Each connector has `has_credentials` boolean, NO `credentials_encrypted` or `credentials_iv` fields.

#### Get connector detail

```bash
curl -s "http://localhost:8788/api/connectors/$CONNECTOR_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** 200, connector object. Verify:
- `has_credentials` field present (boolean)
- `credentials_encrypted` field is NOT present
- `credentials_iv` field is NOT present
- `config` is a JSON string (parsed client-side)
- `created_by_name` is populated

#### Update connector

```bash
curl -s -X PUT "http://localhost:8788/api/connectors/$CONNECTOR_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "subject_patterns": ["Daily COA Report", "COA Requirements", "Weekly COA Summary"],
      "sender_filter": "erp-reports@company.example.com"
    }
  }' | jq .
```

**Expected:** 200, connector with updated config. `updated_at` changed.

#### Deactivate connector

```bash
curl -s -X PUT "http://localhost:8788/api/connectors/$CONNECTOR_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"active": false}' | jq .
```

**Expected:** 200, `active: 0`. Re-activate with `{"active": true}`.

#### Test connector (config validation)

```bash
curl -s -X POST "http://localhost:8788/api/connectors/$CONNECTOR_ID/test" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** 200, `{"success": true, "message": "Connector configuration is valid"}`.

#### Test connector with missing required config

Create a connector missing `subject_patterns`, then test it:

```bash
BAD_ID=$(curl -s http://localhost:8788/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Bad Email Connector",
    "connector_type": "email",
    "config": {},
    "tenant_id": "'"$TENANT_ID"'"
  }' | jq -r '.connector.id')

curl -s -X POST "http://localhost:8788/api/connectors/$BAD_ID/test" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** 400, error mentioning missing `subject_patterns`.

#### Get connector runs (empty)

```bash
curl -s "http://localhost:8788/api/connectors/$CONNECTOR_ID/runs" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** 200, `{"runs": [], "total": 0}`.

#### Soft-delete connector

```bash
curl -s -X DELETE "http://localhost:8788/api/connectors/$CONNECTOR_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** 200, `{"success": true}`. Connector still exists but `active: 0`.

---

### 1.4 Connector Email Ingest

> This endpoint is normally called by the Cloudflare Email Worker with an API key. For testing, use the JWT token.

#### Re-activate or create a connector for ingest

```bash
# Create a fresh connector for the ingest test
INGEST_CONNECTOR_ID=$(curl -s http://localhost:8788/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ERP Email Ingest Test",
    "connector_type": "email",
    "system_type": "erp",
    "config": {
      "subject_patterns": ["Daily COA Report"],
      "sender_filter": "erp@company.example.com"
    },
    "tenant_id": "'"$TENANT_ID"'"
  }' | jq -r '.connector.id')

echo "Ingest connector: $INGEST_CONNECTOR_ID"
```

#### POST a sample email to the ingest endpoint

```bash
curl -s http://localhost:8788/api/webhooks/connector-email-ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "connector_id": "'"$INGEST_CONNECTOR_ID"'",
    "tenant_id": "'"$TENANT_ID"'",
    "subject": "Daily COA Report - April 9, 2026",
    "sender": "erp@company.example.com",
    "body": "Daily COA Requirements Report\nGenerated: 2026-04-09 06:00 AM\n\nOrder Number | Customer # | Customer Name          | PO Number  | Product        | Qty  | Lot #\nSO-2026-0101 | K00123     | Kraft Heinz - Chicago  | PO-90001   | Vanilla Extract| 500  | L2026-0412\nSO-2026-0101 | K00123     | Kraft Heinz - Chicago  | PO-90001   | Cinnamon #1    | 200  | L2026-0413\nSO-2026-0102 | P000456    | PepsiCo Frito-Lay      | PO-90002   | Garlic Powder  | 1000 | L2026-0414\nSO-2026-0103 | M000789    | Mars Wrigley           | PO-90003   | Cocoa Extract  | 750  | L2026-0415\n\nTotal orders: 3\nTotal line items: 4",
    "html": ""
  }' | jq .
```

**Expected:** 200 response with:
```json
{
  "success": true,
  "run_id": "...",
  "status": "completed",
  "orders_created": 3,
  "customers_created": 3
}
```

> Note: The `orders_created` and `customers_created` counts depend on the AI parser output and the orchestrator logic. If the AI is unavailable, the run may complete with `status: "error"`. Check the run details for error_message.

#### Verify orders were created

```bash
curl -s "http://localhost:8788/api/orders?tenant_id=$TENANT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq '.orders[] | {order_number, customer_name, status}'
```

**Expected:** Orders SO-2026-0101, SO-2026-0102, SO-2026-0103 appear with status "pending".

#### Verify customers were created

```bash
curl -s "http://localhost:8788/api/customers?tenant_id=$TENANT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq '.customers[] | {customer_number, name}'
```

**Expected:** Customers K00123, P000456, M000789 appear (or were matched to existing ones).

#### Verify connector run was logged

```bash
curl -s "http://localhost:8788/api/connectors/$INGEST_CONNECTOR_ID/runs" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** `runs` array has 1 entry with `status`, `started_at`, `completed_at`, `orders_created`, `customers_created`.

---

## 2. Sample ERP Email

Use these sample email bodies for testing the AI parser. Each contains the same data in different formats.

### 2.1 Plain Text (Tabular)

```
Subject: Daily COA Report - April 9, 2026
From: erp-reports@company.example.com

=== DAILY COA REQUIREMENTS ===
Report Date: 04/09/2026
Generated by: SAP ERP System

Order #       | Customer #  | Customer Name                | PO #        | Ship Date  | Product              | Qty   | Lot #
------------- | ----------- | ---------------------------- | ----------- | ---------- | -------------------- | ----- | ----------
SO-2026-0101  | K00123      | Kraft Heinz - Chicago Plant  | PO-90001    | 04/12/2026 | Vanilla Extract 4x   | 500   | L2026-0412
SO-2026-0101  | K00123      | Kraft Heinz - Chicago Plant  | PO-90001    | 04/12/2026 | Cinnamon Ground #1   | 200   | L2026-0413
SO-2026-0102  | P000456     | PepsiCo Frito-Lay Dallas     | PO-90002    | 04/13/2026 | Garlic Powder Fine   | 1000  | L2026-0414
SO-2026-0103  | M000789     | Mars Wrigley Confections     | PO-90003    | 04/14/2026 | Cocoa Extract 10x    | 750   | L2026-0415
SO-2026-0103  | M000789     | Mars Wrigley Confections     | PO-90003    | 04/14/2026 | Vanilla Oleoresin    | 300   | L2026-0416

Total: 3 orders, 5 line items
--- END OF REPORT ---
```

### 2.2 HTML Table

```html
<html>
<body>
<h2>Daily COA Requirements Report</h2>
<p>Report Date: April 9, 2026 | Generated: 6:00 AM EST</p>

<table border="1" cellpadding="4" cellspacing="0">
  <thead>
    <tr style="background:#003366;color:white;">
      <th>Order #</th>
      <th>Customer #</th>
      <th>Customer Name</th>
      <th>PO #</th>
      <th>Ship Date</th>
      <th>Product</th>
      <th>Qty</th>
      <th>Lot #</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>SO-2026-0101</td>
      <td>K00123</td>
      <td>Kraft Heinz - Chicago Plant</td>
      <td>PO-90001</td>
      <td>04/12/2026</td>
      <td>Vanilla Extract 4x</td>
      <td>500</td>
      <td>L2026-0412</td>
    </tr>
    <tr>
      <td>SO-2026-0101</td>
      <td>K00123</td>
      <td>Kraft Heinz - Chicago Plant</td>
      <td>PO-90001</td>
      <td>04/12/2026</td>
      <td>Cinnamon Ground #1</td>
      <td>200</td>
      <td>L2026-0413</td>
    </tr>
    <tr>
      <td>SO-2026-0102</td>
      <td>P000456</td>
      <td>PepsiCo Frito-Lay Dallas</td>
      <td>PO-90002</td>
      <td>04/13/2026</td>
      <td>Garlic Powder Fine</td>
      <td>1000</td>
      <td>L2026-0414</td>
    </tr>
    <tr>
      <td>SO-2026-0103</td>
      <td>M000789</td>
      <td>Mars Wrigley Confections</td>
      <td>PO-90003</td>
      <td>04/14/2026</td>
      <td>Cocoa Extract 10x</td>
      <td>750</td>
      <td>L2026-0415</td>
    </tr>
    <tr>
      <td>SO-2026-0103</td>
      <td>M000789</td>
      <td>Mars Wrigley Confections</td>
      <td>PO-90003</td>
      <td>04/14/2026</td>
      <td>Vanilla Oleoresin</td>
      <td>300</td>
      <td>L2026-0416</td>
    </tr>
  </tbody>
</table>

<p><em>Total: 3 orders, 5 line items</em></p>
<p style="font-size:10px;color:#666;">This is an automated report from SAP. Do not reply.</p>
</body>
</html>
```

### 2.3 CSV Attachment Content

```csv
Order Number,Customer Number,Customer Name,PO Number,Ship Date,Product,Quantity,Lot Number
SO-2026-0101,K00123,"Kraft Heinz - Chicago Plant",PO-90001,2026-04-12,Vanilla Extract 4x,500,L2026-0412
SO-2026-0101,K00123,"Kraft Heinz - Chicago Plant",PO-90001,2026-04-12,Cinnamon Ground #1,200,L2026-0413
SO-2026-0102,P000456,"PepsiCo Frito-Lay Dallas",PO-90002,2026-04-13,Garlic Powder Fine,1000,L2026-0414
SO-2026-0103,M000789,"Mars Wrigley Confections",PO-90003,2026-04-14,Cocoa Extract 10x,750,L2026-0415
SO-2026-0103,M000789,"Mars Wrigley Confections",PO-90003,2026-04-14,Vanilla Oleoresin,300,L2026-0416
```

To send the CSV as an attachment via the ingest endpoint, base64-encode it:

```bash
CSV_CONTENT=$(base64 -w0 <<'CSVEOF'
Order Number,Customer Number,Customer Name,PO Number,Ship Date,Product,Quantity,Lot Number
SO-2026-0101,K00123,"Kraft Heinz - Chicago Plant",PO-90001,2026-04-12,Vanilla Extract 4x,500,L2026-0412
SO-2026-0101,K00123,"Kraft Heinz - Chicago Plant",PO-90001,2026-04-12,Cinnamon Ground #1,200,L2026-0413
SO-2026-0102,P000456,"PepsiCo Frito-Lay Dallas",PO-90002,2026-04-13,Garlic Powder Fine,1000,L2026-0414
SO-2026-0103,M000789,"Mars Wrigley Confections",PO-90003,2026-04-14,Cocoa Extract 10x,750,L2026-0415
SO-2026-0103,M000789,"Mars Wrigley Confections",PO-90003,2026-04-14,Vanilla Oleoresin,300,L2026-0416
CSVEOF
)

curl -s http://localhost:8788/api/webhooks/connector-email-ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "connector_id": "'"$INGEST_CONNECTOR_ID"'",
    "tenant_id": "'"$TENANT_ID"'",
    "subject": "Daily COA Report - April 9, 2026",
    "sender": "erp@company.example.com",
    "body": "Please see attached daily COA requirements report.",
    "attachments": [{
      "filename": "coa_report_20260409.csv",
      "content_base64": "'"$CSV_CONTENT"'",
      "content_type": "text/csv",
      "size": 512
    }]
  }' | jq .
```

---

## 3. UI Walkthrough

### 3.1 Login

1. Open `http://localhost:8788` in browser
2. Login as admin (email/password from seed)
3. Verify dashboard loads

### 3.2 Navigate to Connectors

1. Click **Admin** in the left nav
2. Click **Connectors**
3. Verify the Connectors list page loads (may be empty)

### 3.3 Add Connector (Wizard)

1. Click **Add Connector** button
2. **Step 1 - Basics:**
   - Name: `Daily ERP Order Email`
   - Connector Type: select `Email`
   - System Type: select `ERP`
   - Click **Next**
3. **Step 2 - Configuration:**
   - Subject Patterns: enter `Daily COA Report` (add a second: `COA Requirements`)
   - Sender Filter: enter `erp-reports@company.example.com`
   - Click **Next**
4. **Step 3 - Field Mappings:**
   - Verify default mappings are shown (order_number, customer_number, customer_name)
   - Adjust if needed
   - Click **Next**
5. **Step 4 - Review:**
   - Verify all entered values are displayed correctly
   - Click **Save** / **Create**
6. Verify redirect to connector list or detail page
7. Verify the new connector appears in the list with:
   - Name: "Daily ERP Order Email"
   - Type: "email"
   - System: "erp"
   - Status: Active

### 3.4 Connector Detail Page

1. Click on the connector name to open the detail page
2. Verify:
   - Name and type displayed correctly
   - Config shows subject_patterns and sender_filter
   - No credential values are exposed (just "Has credentials: No" or similar)
   - Created by name is shown
   - Run history section is empty
3. Click **Test Connection** button
4. Verify success message: "Connector configuration is valid"

### 3.5 Customers Page

1. Navigate to **Customers** in the nav
2. Verify the customers list loads
3. If customers were created via API tests above, verify they appear
4. Click **Add Customer** if available and create one via the UI form
5. Verify search works (type a customer name in the search box)

### 3.6 Orders Page

1. Navigate to **Orders** in the nav
2. Verify the orders list loads
3. If orders were created via API or ingest tests, verify they appear
4. Verify status filter works (select "pending" from dropdown)
5. Click an order to open the detail page
6. Verify items are listed with product names, quantities, lot numbers

---

## 4. Integration Test (End-to-End)

This tests the full flow: connector setup through order creation.

### 4.1 Setup

1. Ensure dev server is running (`npm run dev`)
2. Ensure Qwen proxy is running on port 9600 (needed for AI parsing)
   - If not, the email ingest will return an error status
3. Login and get a token (see Section 0)

### 4.2 Create Connector

```bash
CONNECTOR_ID=$(curl -s http://localhost:8788/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "E2E Test - ERP Email",
    "connector_type": "email",
    "system_type": "erp",
    "config": {
      "subject_patterns": ["Daily COA Report"],
      "sender_filter": "erp@company.example.com"
    },
    "field_mappings": {
      "order_number": "order_number",
      "customer_number": "customer_number",
      "customer_name": "customer_name",
      "po_number": "po_number"
    },
    "tenant_id": "'"$TENANT_ID"'"
  }' | jq -r '.connector.id')

echo "E2E Connector: $CONNECTOR_ID"
```

### 4.3 Verify connector is valid

```bash
curl -s -X POST "http://localhost:8788/api/connectors/$CONNECTOR_ID/test" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Expected:** `{"success": true, "message": "Connector configuration is valid"}`

### 4.4 Send test email via ingest endpoint

```bash
curl -s http://localhost:8788/api/webhooks/connector-email-ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "connector_id": "'"$CONNECTOR_ID"'",
    "tenant_id": "'"$TENANT_ID"'",
    "subject": "Daily COA Report - April 9, 2026",
    "sender": "erp@company.example.com",
    "body": "Order #       | Customer #  | Customer Name              | PO #      | Product            | Qty  | Lot #\nSO-2026-0201  | K00123      | Kraft Heinz - Chicago      | PO-90010  | Vanilla Extract 4x | 500  | L2026-0500\nSO-2026-0202  | G000321     | General Mills Minneapolis  | PO-90011  | Cinnamon Ground    | 300  | L2026-0501\nSO-2026-0203  | N000555     | Nestle USA                 | PO-90012  | Cocoa Powder       | 800  | L2026-0502"
  }' | jq .
```

**Expected:** Note the `run_id`, `orders_created`, `customers_created` from the response.

### 4.5 Verify orders in API

```bash
curl -s "http://localhost:8788/api/orders?tenant_id=$TENANT_ID&status=pending" \
  -H "Authorization: Bearer $TOKEN" | jq '.orders[] | {order_number, customer_name, status, item_count}'
```

**Expected:** Orders SO-2026-0201, SO-2026-0202, SO-2026-0203 appear with correct customer names.

### 4.6 Verify customers in API

```bash
curl -s "http://localhost:8788/api/customers?tenant_id=$TENANT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq '.customers[] | {customer_number, name}'
```

**Expected:** K00123, G000321, N000555 customers exist (created or matched).

### 4.7 Verify connector run history

```bash
curl -s "http://localhost:8788/api/connectors/$CONNECTOR_ID/runs" \
  -H "Authorization: Bearer $TOKEN" | jq '.runs[0]'
```

**Expected:** Run entry with `status: "completed"`, timestamps, and counts.

### 4.8 Verify in UI

1. Open browser to `http://localhost:8788`
2. Navigate to **Orders** -- verify the 3 new orders appear
3. Click into an order -- verify items/products/lot numbers are shown
4. Navigate to **Customers** -- verify new customers appear
5. Navigate to **Admin > Connectors** -- click the E2E test connector
6. Verify the run history shows 1 completed run with timestamp and counts

### 4.9 Cleanup

```bash
# Delete test orders
for id in $(curl -s "http://localhost:8788/api/orders?tenant_id=$TENANT_ID&search=SO-2026-02" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.orders[].id'); do
  curl -s -X DELETE "http://localhost:8788/api/orders/$id" \
    -H "Authorization: Bearer $TOKEN" > /dev/null
  echo "Deleted order: $id"
done

# Deactivate test connector
curl -s -X DELETE "http://localhost:8788/api/connectors/$CONNECTOR_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## 5. Edge Cases and Error Handling

Quick checks to run after the main tests pass:

| Test | Command/Action | Expected |
|------|---------------|----------|
| Missing tenant_id | `curl ... /api/customers` without tenant_id (as super_admin) | 400: "tenant_id is required" |
| Duplicate customer_number | POST same customer_number twice | DB constraint error or 500 |
| Empty order_number | POST order with `"order_number": ""` | 400: "order_number is required" |
| Inactive connector ingest | POST email-ingest to a deactivated connector | 400: "Connector is not active" |
| Wrong connector type | POST email-ingest to an `api_poll` connector | 400: "Connector is not an email type" |
| Tenant mismatch | POST email-ingest with mismatched tenant_id | 403: "Tenant mismatch" |
| Non-existent connector | POST email-ingest with fake connector_id | 404: "Connector not found" |
| Reader role creates customer | Login as reader, POST to /api/customers | 403 (role check fails) |
| Unauthenticated request | Omit Authorization header | 401 |
