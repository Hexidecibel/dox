import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { TenantProvider } from './contexts/TenantContext';
import { ReleaseNotesProvider } from './contexts/ReleaseNotesContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { VersionChip } from './components/VersionChip';
import { WhatsNewToast } from './components/WhatsNewToast';
import { Login } from './pages/Login';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';
import { Dashboard } from './pages/Dashboard';
import { Documents } from './pages/Documents';
import { DocumentDetail } from './pages/DocumentDetail';
import { Search } from './pages/Search';
import { Profile } from './pages/Profile';
import { Users } from './pages/admin/Users';
import { Tenants } from './pages/admin/Tenants';
import { AuditLog } from './pages/admin/AuditLog';
import { ApiKeys } from './pages/admin/ApiKeys';
import { Products } from './pages/admin/Products';
import { ProductDetail } from './pages/admin/ProductDetail';
import { Suppliers } from './pages/admin/Suppliers';
import { SupplierDetail } from './pages/admin/SupplierDetail';
import { DocumentTypes } from './pages/admin/DocumentTypes';
import { Bundles } from './pages/Bundles';
import { BundleDetail } from './pages/BundleDetail';
import { IngestHistory } from './pages/IngestHistory';
import { Import } from './pages/Import';
import ReviewQueue from './pages/ReviewQueue';
import Eval from './pages/Eval';
import EvalReport from './pages/EvalReport';
import { Connectors } from './pages/admin/Connectors';
import { ConnectorDetail } from './pages/admin/ConnectorDetail';
import { ConnectorWizard } from './pages/admin/ConnectorWizard';
import { Customers } from './pages/admin/Customers';
import { CustomerDetail } from './pages/admin/CustomerDetail';
import LearningDashboard from './pages/admin/LearningDashboard';
import { Orders } from './pages/Orders';
import { OrderDetail } from './pages/OrderDetail';
import { Activity } from './pages/Activity';
import { Sheets } from './pages/records/Sheets';
import { SheetDetail } from './pages/records/SheetDetail';
import { FormBuilder } from './pages/records/FormBuilder';
import { WorkflowBuilder } from './pages/records/WorkflowBuilder';
import { PublicForm } from './pages/forms/PublicForm';
import { UpdateRequestForm } from './pages/forms/UpdateRequestForm';
import { PublicApprovalPage } from './pages/forms/PublicApprovalPage';
import { PublicDrop } from './pages/PublicDrop';
import { PublicDocsConnectors } from './pages/PublicDocsConnectors';
import { Approvals } from './pages/Approvals';
import { Help } from './pages/Help';

function App() {
  return (
    <AuthProvider>
      <TenantProvider>
        <ReleaseNotesProvider>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />

          {/* Public form route — no app shell, no auth, full-screen takeover */}
          <Route path="/f/:slug" element={<PublicForm />} />

          {/* Public update-request route — recipient-only form gated by an
              unguessable token. Same no-shell, no-auth treatment as /f/. */}
          <Route path="/u/:token" element={<UpdateRequestForm />} />

          {/* Public workflow approval route — magic-link decision page. */}
          <Route path="/a/:token" element={<PublicApprovalPage />} />

          {/* Phase B4 — public drop link. Vendors land here from a
              tenant-shared URL; the link token is the auth, the
              page renders an upload form, and submissions POST to
              the existing /api/connectors/:slug/drop endpoint with
              the token as the bearer. No app shell, no login. */}
          <Route path="/drop/:slug/:token" element={<PublicDrop />} />

          {/* Phase D5 — vendor-facing public docs. Tenant admins
              share this URL with their vendors so they have a
              single canonical reference for every connector
              delivery door (email, API, S3, public link, manual).
              No auth, no app shell — pure documentation. */}
          <Route path="/docs/connectors" element={<PublicDocsConnectors />} />

          {/* Protected routes with layout */}
          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/documents" element={<Documents />} />
              <Route path="/documents/:id" element={<DocumentDetail />} />
              <Route path="/search" element={<Search />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/bundles" element={<Bundles />} />
              <Route path="/bundles/:id" element={<BundleDetail />} />
              <Route path="/ingest-history" element={<IngestHistory />} />
              <Route path="/activity" element={<Activity />} />
              <Route path="/import" element={<Import />} />
              <Route path="/review" element={<ReviewQueue />} />
              <Route path="/eval" element={<Eval />} />
              <Route path="/eval/report" element={<EvalReport />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="/orders/:id" element={<OrderDetail />} />
              <Route path="/records" element={<Sheets />} />
              <Route path="/records/:sheetId" element={<SheetDetail />} />
              <Route path="/records/:sheetId/forms/:formId" element={<FormBuilder />} />
              <Route path="/records/:sheetId/workflows/:workflowId" element={<WorkflowBuilder />} />
              <Route path="/approvals" element={<Approvals />} />
              <Route path="/help" element={<Help />} />
              <Route path="/help/:module" element={<Help />} />

              {/* Admin routes - users management and audit for super_admin and org_admin */}
              <Route element={<ProtectedRoute roles={['super_admin', 'org_admin']} />}>
                <Route path="/admin/users" element={<Users />} />
                <Route path="/admin/api-keys" element={<ApiKeys />} />
                <Route path="/admin/audit" element={<AuditLog />} />
                <Route path="/admin/document-types" element={<DocumentTypes />} />
                <Route path="/admin/products" element={<Products />} />
                <Route path="/admin/products/:id" element={<ProductDetail />} />
                <Route path="/admin/suppliers" element={<Suppliers />} />
                <Route path="/admin/suppliers/:id" element={<SupplierDetail />} />
                <Route path="/admin/connectors" element={<Connectors />} />
                <Route path="/admin/connectors/new" element={<ConnectorWizard />} />
                <Route path="/admin/connectors/:id/edit" element={<ConnectorWizard />} />
                <Route path="/admin/connectors/:id" element={<ConnectorDetail />} />
                <Route path="/admin/customers" element={<Customers />} />
                <Route path="/admin/customers/:id" element={<CustomerDetail />} />
                <Route path="/admin/learning-dashboard" element={<LearningDashboard />} />
              </Route>
              {/* Super admin only routes */}
              <Route element={<ProtectedRoute roles={['super_admin']} />}>
                <Route path="/admin/tenants" element={<Tenants />} />
              </Route>
            </Route>
          </Route>

          {/* Redirect root to dashboard */}
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
        <VersionChip />
        <WhatsNewToast />
        </ReleaseNotesProvider>
      </TenantProvider>
    </AuthProvider>
  );
}

export default App;
