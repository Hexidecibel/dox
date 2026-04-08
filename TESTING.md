# Feature Testing Plan — Dox

Live URL: https://supdox.com
Super Admin: admin@example.com
Estimated Time: 30-45 minutes

---

## 1. Authentication

### Login
- [ ] Go to https://supdox.com
- [ ] Should redirect to /login if not authenticated
- [ ] Log in as admin@example.com with the known password
- [ ] Should redirect to /dashboard
- [ ] Dashboard shows welcome message and stats cards (document count, user count, tenant count)
- [ ] Verify the user's name and role (super_admin) appear in the UI (sidebar or header)

### Session Persistence
- [ ] Refresh the page (F5) while on /dashboard
- [ ] Should remain logged in (not kicked to /login)
- [ ] Open a new tab and go to https://supdox.com/dashboard — should load without login prompt

### Logout
- [ ] Click Sign Out
- [ ] Should redirect to /login
- [ ] Try navigating directly to https://supdox.com/dashboard
- [ ] Should redirect back to /login (token is revoked server-side)

### Login Again
- [ ] Log back in as admin@example.com — you will need this session for the remaining tests

---

## 2. Tenant Management

### Create a Test Tenant
- [ ] Navigate to tenant management (likely under an Admin or Tenants menu)
- [ ] Create a new tenant named **"Acme Manufacturing"**
- [ ] Add a description: "Test tenant for QA"
- [ ] Confirm creation succeeds — tenant appears in the list
- [ ] Note the slug was auto-generated (should be "acme-manufacturing")

### Edit a Tenant
- [ ] Click to edit "Acme Manufacturing"
- [ ] Change the description to "Test tenant for QA - updated"
- [ ] Save and verify the description updated

### Verify Tenant Selector
- [ ] Look for a tenant selector dropdown (super_admin feature)
- [ ] "Acme Manufacturing" should appear as an option
- [ ] Select it — the UI should filter to show only that tenant's data

### Create a Second Tenant
- [ ] Create another tenant: **"Beta Industries"**
- [ ] This will be used later for tenant isolation testing

---

## 3. User Invitations

### Create an Org Admin
- [ ] Navigate to user management
- [ ] Create a new user:
  - Email: a real email you can check (or a test address)
  - Name: "Acme Admin"
  - Role: **org_admin**
  - Tenant: Acme Manufacturing
  - Password: a strong password (e.g., "AcmeAdmin1")
- [ ] Verify creation succeeds
- [ ] Check if an invitation email arrives at the specified address (sent from noreply@supdox.com via Resend)
- [ ] Email should contain login credentials and a sign-in link

### Create a Regular User
- [ ] Create another user:
  - Name: "Acme User"
  - Role: **user**
  - Tenant: Acme Manufacturing
  - Password: "AcmeUser1"
- [ ] Verify creation succeeds

### Create a Reader
- [ ] Create another user:
  - Name: "Acme Reader"
  - Role: **reader**
  - Tenant: Acme Manufacturing
  - Password: "AcmeReader1"
- [ ] Verify creation succeeds

### Create a User in the Second Tenant
- [ ] Create a user:
  - Name: "Beta User"
  - Role: **user**
  - Tenant: Beta Industries
  - Password: "BetaUser1"
- [ ] This will be used for tenant isolation testing

---

## 4. Role-Based Access Control

### Test as Org Admin (Acme Admin)
- [ ] Log out of super_admin
- [ ] Log in as the Acme Admin account
- [ ] **Can see**: User management (for own tenant), document management, audit log
- [ ] **Can do**: Create user/reader accounts in Acme Manufacturing, manage documents
- [ ] **Cannot do**: Create tenants, see other tenants, create org_admin or super_admin users
- [ ] Log out

### Test as User (Acme User)
- [ ] Log in as Acme User
- [ ] **Can see**: Documents page, own profile
- [ ] **Can do**: Create documents, upload files, edit documents, delete documents
- [ ] **Cannot see**: User management, audit log, tenant management
- [ ] **Cannot do**: Create users, view audit logs
- [ ] Log out

### Test as Reader (Acme Reader)
- [ ] Log in as Acme Reader
- [ ] **Can see**: Documents page (read-only), own profile
- [ ] **Can do**: View documents, download files, search, generate reports
- [ ] **Cannot do**: Create documents, upload files, edit or delete documents
- [ ] Verify the "Create Document" button is hidden or disabled
- [ ] Log out

### Return to Super Admin
- [ ] Log back in as admin@example.com for remaining tests

---

## 5. Document Management

### Create a Document
- [ ] Navigate to documents
- [ ] Click "Create Document" (or equivalent button)
- [ ] Fill in:
  - Title: "Safety Data Sheet - Widget A"
  - Description: "SDS per OSHA 2024 requirements"
  - Category: "regulatory"
  - Tags: "safety", "osha"
- [ ] Make sure the tenant is set to Acme Manufacturing
- [ ] Save — document should appear in the list with version 0 (no file yet)

### Upload a PDF
- [ ] Open the newly created document
- [ ] Upload a PDF file
- [ ] Add change notes: "Initial upload"
- [ ] Verify upload succeeds — version should now be 1
- [ ] File name, size, and MIME type should display correctly

### Upload an Image
- [ ] Create a second document: "Product Photo - Widget A"
- [ ] Upload a .jpg or .png image
- [ ] Verify upload succeeds

### Upload a Text/CSV File
- [ ] Create a third document: "Compliance Checklist"
- [ ] Upload a .csv or .txt file
- [ ] Verify upload succeeds

### Edit Document Metadata
- [ ] Go back to "Safety Data Sheet - Widget A"
- [ ] Edit the title to "Safety Data Sheet - Widget A (Rev 1)"
- [ ] Change or add a tag
- [ ] Save and verify the changes persisted

### Delete a Document
- [ ] Create a throwaway document: "Test Delete"
- [ ] Delete it
- [ ] Verify it is soft-deleted (status changes to "deleted") and no longer appears in the default document list

---

## 6. Document Versioning

### Upload a Second Version
- [ ] Open "Safety Data Sheet - Widget A (Rev 1)"
- [ ] Upload a different PDF file
- [ ] Add change notes: "Updated section 4.2 with new regulations"
- [ ] Verify version is now 2

### Check Version History
- [ ] View the version history for this document
- [ ] Should show version 1 and version 2
- [ ] Each version should display: file name, size, uploader name, date, and change notes

### Download a Specific Version
- [ ] Download version 1 — verify you get the original file
- [ ] Download version 2 — verify you get the updated file
- [ ] Download "current" — should match version 2

---

## 7. Search

### Search by Title
- [ ] Use the search feature
- [ ] Search for "Safety" — should return the Safety Data Sheet document
- [ ] Search for "Widget" — should return documents with "Widget" in the title

### Search by Category
- [ ] Filter by category "regulatory"
- [ ] Only documents in that category should appear

### Verify Tenant Filtering
- [ ] As super_admin, switch to "Acme Manufacturing" tenant — search should only return Acme docs
- [ ] Switch to "Beta Industries" — search should return only Beta docs (probably none yet)
- [ ] Clear tenant filter — should show all documents across tenants

### Edge Cases
- [ ] Search for a term that does not exist — should return empty results, not an error
- [ ] Search with an empty query — should return all documents (or prompt for input)

---

## 8. Reports

### Generate a CSV Report
- [ ] Navigate to the reports section
- [ ] Select CSV format
- [ ] Generate the report
- [ ] Download the file and open it
- [ ] Verify columns: Title, Category, Tags, Status, Current Version, File Name, File Size (KB), Uploaded By, Created Date, Last Updated
- [ ] Verify the documents you created appear in the report

### Generate a JSON Report
- [ ] Generate a report in JSON format
- [ ] Download or view the output
- [ ] Verify it contains the same documents as the CSV
- [ ] Verify the JSON structure is valid and fields are correct

### Filtered Report
- [ ] Generate a report filtered by category "regulatory"
- [ ] Verify only matching documents appear
- [ ] Try a date range filter if available

---

## 9. Audit Log

### View Audit Log
- [ ] Navigate to the audit log (Admin section)
- [ ] Verify entries exist for all actions performed so far:
  - [ ] `login` — your login events
  - [ ] `tenant_created` — Acme Manufacturing and Beta Industries
  - [ ] `user_created` — the users you created
  - [ ] `document_created` — the documents you created
  - [ ] `document_version_uploaded` — file uploads
  - [ ] `document_updated` — metadata edits
  - [ ] `document_deleted` — the soft-deleted document
  - [ ] `document_downloaded` — any downloads you performed
  - [ ] `report.generate` — report generation events

### Diff Tracking
- [ ] Find the `document_updated` entry for the title change
- [ ] Expand the details — should show before/after diff (old title vs new title)

### Filter Audit Log
- [ ] Filter by action type (e.g., "document_created")
- [ ] Filter by user
- [ ] Filter by date range
- [ ] Verify filters work correctly and narrow results

---

## 10. API Keys

### Create an API Key
- [ ] Log in as super_admin (admin@example.com)
- [ ] Navigate to API Keys management (Settings or Admin section)
- [ ] Click "Create API Key"
- [ ] Enter a name: "Test Automation Key"
- [ ] Optionally select a tenant scope (e.g., Acme Manufacturing)
- [ ] Submit — a new key should be created
- [ ] **IMPORTANT**: Copy the full key (starts with `dox_sk_`). It is shown only once.
- [ ] Verify the key appears in the list with name, prefix, and creation date

### Use the API Key with curl
- [ ] Use the copied key to make an API request:
  ```bash
  curl https://supdox.com/api/users/me \
    -H "X-API-Key: dox_sk_YOUR_KEY_HERE"
  ```
- [ ] Should return the super_admin user profile (the key authenticates as the user who created it)

### Use the API Key for Document Access
- [ ] List documents using the API key:
  ```bash
  curl https://supdox.com/api/documents \
    -H "X-API-Key: dox_sk_YOUR_KEY_HERE"
  ```
- [ ] Should return documents (scoped to the key's tenant if one was set)

### Revoke the API Key
- [ ] In the UI, find the "Test Automation Key" in the API Keys list
- [ ] Click "Revoke" (or the delete/revoke button)
- [ ] Confirm the action
- [ ] The key should now show as revoked in the list

### Verify Revoked Key Is Rejected
- [ ] Try using the revoked key:
  ```bash
  curl https://supdox.com/api/users/me \
    -H "X-API-Key: dox_sk_YOUR_REVOKED_KEY"
  ```
- [ ] Should return 401 "Invalid API key"

---

## 11. Document Ingestion

### Create an API Key for Ingestion
- [ ] Create a new API key named "Ingestion Agent" (scoped to Acme Manufacturing)
- [ ] Copy the key

### Ingest a New Document
- [ ] Use curl to ingest a document:
  ```bash
  curl -X POST https://supdox.com/api/documents/ingest \
    -H "X-API-Key: dox_sk_YOUR_KEY" \
    -F "file=@/path/to/test-document.pdf" \
    -F "external_ref=TEST-REF-001" \
    -F "tenant_id=ACME_TENANT_ID" \
    -F "title=Ingested Test Document" \
    -F "category=test" \
    -F 'tags=["ingested","test"]' \
    -F "changeNotes=Initial ingestion via API" \
    -F 'source_metadata={"source":"test","method":"curl"}'
  ```
- [ ] Response should have `"action": "created"` and status 201
- [ ] Verify the document appears in the Acme Manufacturing document list in the UI
- [ ] Check that external_ref and source_metadata are set on the document

### Ingest Again with Same external_ref (Version Upsert)
- [ ] Run the same curl command again with a different file (or same file):
  ```bash
  curl -X POST https://supdox.com/api/documents/ingest \
    -H "X-API-Key: dox_sk_YOUR_KEY" \
    -F "file=@/path/to/updated-document.pdf" \
    -F "external_ref=TEST-REF-001" \
    -F "tenant_id=ACME_TENANT_ID" \
    -F "changeNotes=Updated version via API"
  ```
- [ ] Response should have `"action": "version_added"` and status 200
- [ ] Verify document now shows version 2 in the UI
- [ ] Check version history — should show version 1 and version 2

---

## 12. Document Lookup

### Look Up by external_ref
- [ ] Use curl to look up the ingested document:
  ```bash
  curl "https://supdox.com/api/documents/lookup?external_ref=TEST-REF-001&tenant_id=ACME_TENANT_ID" \
    -H "X-API-Key: dox_sk_YOUR_KEY"
  ```
- [ ] Should return the document with current version info
- [ ] Verify the `external_ref` matches what was set during ingestion

### Lookup for Non-Existent Reference
- [ ] Look up a reference that does not exist:
  ```bash
  curl "https://supdox.com/api/documents/lookup?external_ref=DOES-NOT-EXIST&tenant_id=ACME_TENANT_ID" \
    -H "X-API-Key: dox_sk_YOUR_KEY"
  ```
- [ ] Should return 404 "Document not found"

---

## 13. Forgot Password

### Request Password Reset
- [ ] Log out
- [ ] On the login page, click "Forgot Password"
- [ ] Enter the email of one of the test users
- [ ] Submit — should always show a generic success message ("If an account exists...")
- [ ] Check email for the reset link (sent from noreply@supdox.com)

### Complete the Reset
- [ ] Click the reset link from the email
- [ ] Should open a reset password form
- [ ] Enter a new password (must meet requirements: 8+ chars, uppercase, lowercase, number)
- [ ] Submit — should succeed and redirect to login
- [ ] Log in with the new password — should work
- [ ] Try the old password — should fail

### Rate Limiting
- [ ] Submit forgot-password requests rapidly (4+ times in 15 minutes for the same IP)
- [ ] Should get rate limited (429) after 3 attempts

### Non-Existent Email
- [ ] Enter an email that does not exist in the system
- [ ] Should show the same generic success message (no enumeration leak)

---

## 14. Admin Password Reset

### Reset a User's Password
- [ ] Log in as super_admin (admin@example.com)
- [ ] Navigate to user management
- [ ] Find one of the test users (e.g., Acme User)
- [ ] Click "Reset Password" (admin action)
- [ ] A temporary password should be generated and displayed
- [ ] Note: the user's `force_password_change` flag is now set
- [ ] Check if a notification email was sent to the user

### Verify Force Password Change
- [ ] Log out of super_admin
- [ ] Log in as the user whose password was just reset (use the temporary password)
- [ ] Should be prompted (or forced) to change the password before proceeding
- [ ] Set a new password
- [ ] Verify you can now use the app normally with the new password

### Verify All Sessions Were Revoked
- [ ] If the user had any other active sessions, they should all be invalidated
- [ ] Trying to use an old token for this user should return 401

### Return to Super Admin
- [ ] Log back in as admin@example.com

---

## 15. Document Preview

### PDF Preview
- [ ] Open a document that has a PDF uploaded
- [ ] Click preview/view — PDF should render inline in the browser (embedded viewer via iframe)
- [ ] Verify pages are readable and navigable

### Image Preview
- [ ] Open a document with a .jpg or .png file
- [ ] Preview should show the image inline (rendered as an `<img>` tag)
- [ ] Verify the image displays correctly and is appropriately sized

### Text/CSV Preview
- [ ] Open a document with a .txt file
- [ ] Preview should display the text content inline in a code block
- [ ] Open a document with a .csv file
- [ ] Preview should display the data as a formatted table

### Office Document (Edge Case)
- [ ] If you have a .docx or .xlsx file, upload it to a document
- [ ] Preview should show a download card (not inline preview, since Office docs cannot be rendered in-browser)
- [ ] Verify the download button works

---

## 16. File Name Search

### Search by File Name
- [ ] Upload a file with a distinctive name (e.g., "quarterly-safety-2024-q3.pdf") to a document
- [ ] Use the search feature to search for "quarterly-safety"
- [ ] The document should appear in results (matched via the file name in document_versions)

### Search Still Works for Title, Description, Tags
- [ ] Search for a term that appears only in a document's title — should still work
- [ ] Search for a term that appears only in a tag — should still work
- [ ] Search for a term that appears only in a description — should still work

### Verify Combined Matching
- [ ] Search for a term that matches a file name but not the document title
- [ ] The document should still be returned (the join with document_versions enables this)

---

## 17. Mobile Responsiveness

### Narrow Browser Window
- [ ] Resize browser to ~375px wide (phone viewport) or use DevTools device emulation
- [ ] **Sidebar**: Should collapse (hamburger menu or hidden)
- [ ] **Tables**: Should convert to card layout or become horizontally scrollable
- [ ] **Dialogs/Modals**: Should go full-screen or nearly full-screen on narrow viewports
- [ ] **Forms**: Input fields should stack vertically, no horizontal overflow

### Key Pages to Check
- [ ] Login page — fields should be centered and usable
- [ ] Dashboard — stats cards should stack vertically
- [ ] Document list — readable without horizontal scroll
- [ ] Document detail/preview — preview area should resize appropriately
- [ ] User management table — should be usable on mobile

### Touch Targets
- [ ] Buttons and links should be large enough to tap (minimum ~44px)
- [ ] Dropdown menus should be accessible

---

## 18. GraphQL

### GraphiQL Playground
- [ ] Navigate to https://supdox.com/api/graphql in the browser
- [ ] GraphiQL IDE should load (interactive query editor)
- [ ] Set the Authorization header to `Bearer <your-token>` (you may need to get the token from browser DevTools > Application > localStorage or Network tab)

### Test a Query
- [ ] Run this query:
  ```graphql
  query {
    me {
      id
      email
      name
      role
    }
  }
  ```
- [ ] Should return your super_admin user details

### Test a More Complex Query
- [ ] Run:
  ```graphql
  query {
    documents(status: ACTIVE, limit: 5) {
      id
      title
      category
      currentVersion
      createdBy {
        name
      }
    }
  }
  ```
- [ ] Should return the documents you created

### Test a Mutation
- [ ] Run:
  ```graphql
  query {
    auditLog(limit: 5) {
      total
      entries {
        action
        resourceType
        createdAt
      }
    }
  }
  ```
- [ ] Should return recent audit log entries

---

## 19. Security

### Unauthorized Access
- [ ] Log in as the Reader account (Acme Reader)
- [ ] Try navigating directly to admin pages (e.g., /users, /tenants, /audit)
- [ ] Should be blocked — either hidden from navigation or show a 403/redirect

### API-Level Permission Enforcement
- [ ] As Reader, open browser DevTools > Console
- [ ] Try calling a restricted API:
  ```js
  fetch('/api/tenants', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') }, body: JSON.stringify({ name: 'Hack Tenant' }) }).then(r => r.json()).then(console.log)
  ```
- [ ] Should return 403 Forbidden

### Rate Limiting on Login
- [ ] Log out
- [ ] Attempt to log in with a wrong password 5 times in a row (same email)
- [ ] On the 6th attempt (even with the correct password), should get a 429 "Too Many Requests" response
- [ ] Wait 15 minutes or note that the rate limit window is 15 minutes

### Security Headers
- [ ] Open DevTools > Network tab
- [ ] Make any request and inspect the response headers
- [ ] Look for security headers set by the middleware (e.g., X-Content-Type-Options, X-Frame-Options, Content-Security-Policy, etc.)

---

## 20. Tenant Isolation

### Setup
- [ ] Log in as super_admin
- [ ] Create a document in "Beta Industries" tenant:
  - Title: "Beta Compliance Report"
  - Upload a file to it

### Test Isolation as Tenant User
- [ ] Log in as "Acme User" (belongs to Acme Manufacturing)
- [ ] View the documents list
- [ ] "Beta Compliance Report" should NOT appear
- [ ] Search for "Beta" — should return no results

### API-Level Isolation
- [ ] As Acme User, try to access the Beta document directly via API (if you know the document ID):
  ```js
  fetch('/api/documents/BETA_DOC_ID', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') } }).then(r => r.json()).then(console.log)
  ```
- [ ] Should return 403 or 404 (not the document)

### Verify No Data Leakage
- [ ] As Acme User, check that the user list (if visible) only shows Acme Manufacturing users
- [ ] Tenant dropdown (if visible) should only show own tenant

---

## 21. Super Admin Tenant Switching

### Tenant Selector
- [ ] Log in as super_admin (admin@example.com)
- [ ] Locate the tenant selector dropdown (should be in the header or sidebar)
- [ ] Should list all tenants: Acme Manufacturing, Beta Industries, and any others

### Filter by Tenant
- [ ] Select "Acme Manufacturing"
- [ ] Documents list should show only Acme documents
- [ ] User list should show only Acme users (if filtered)
- [ ] Audit log should show only Acme-related entries

### Switch Tenants
- [ ] Select "Beta Industries"
- [ ] Documents should update to show only Beta documents
- [ ] Verify the UI clearly indicates which tenant is selected

### Show All
- [ ] Select "All Tenants" (or clear the filter)
- [ ] Should show documents and data across all tenants
- [ ] This is the super_admin's default view

---

## Cleanup (Optional)

After testing, you may want to:
- [ ] Deactivate the test users (Acme Admin, Acme User, Acme Reader, Beta User)
- [ ] Deactivate the test tenants (Acme Manufacturing, Beta Industries) — or keep them for future testing
- [ ] Delete test documents if desired

---

## Notes

- **Password requirements**: 8-128 characters, must contain uppercase, lowercase, and a number
- **Rate limits**: Login = 5 attempts / 15 min per IP+email; Forgot password = 3 attempts / 15 min per IP
- **Token expiry**: JWT tokens expire after 24 hours
- **Allowed file types**: PDF, DOC, DOCX, XLS, XLSX, CSV, TXT, PNG, JPG (max 100 MB)
- **Emails**: Sent via Resend from noreply@supdox.com — check spam/junk folders if not in inbox
