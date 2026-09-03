import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { TenantProvider } from './contexts/TenantContext';
import { ReleaseNotesProvider } from './contexts/ReleaseNotesContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { VersionChip } from './components/VersionChip';
import { WhatsNewToast } from './components/WhatsNewToast';
import { SURFACES } from './lib/surfaces';
import { Login } from './pages/Login';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';
import { PublicForm } from './pages/forms/PublicForm';
import { UpdateRequestForm } from './pages/forms/UpdateRequestForm';
import { PublicApprovalPage } from './pages/forms/PublicApprovalPage';
import { AlertLanding } from './pages/AlertLanding';
import { PublicDrop } from './pages/PublicDrop';
// The external supplier request page. Unauthenticated, token-gated: see
// functions/api/supplier-requests/public/[token].ts.
import { SupplierRequestPortal } from './pages/supplier/RequestPortal';
import { PublicDocsConnectors } from './pages/PublicDocsConnectors';

/**
 * Routing.
 *
 * Everything inside the authenticated shell comes from `src/lib/surfaces.tsx`
 * — one row per surface, carrying its path, element, permission tier, module
 * and optional nav entry. The nav rail is rendered from the SAME rows, which
 * is the point: this file and `Layout.tsx` used to be two independent lists of
 * paths and had already drifted in both directions (a `user` could work the
 * review queue by URL but saw no link; a `user` saw the Out-of-Spec link and
 * was bounced by the route). A path can no longer exist in one and not the
 * other, because there is only one place to write it.
 *
 * The `roles` on a surface is exactly what the old nested
 * `<ProtectedRoute roles={[...]}>` blocks meant — the nesting was only ever a
 * way to avoid repeating the tier, so flattening it loses nothing.
 *
 * The PUBLIC routes below stay hand-written. They are outside the shell: no
 * auth, no layout, no nav entry and no module, so a `Surface` row for them
 * would be three empty fields and a lie about where they live.
 */
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

          {/* Alert landing page. Some of the people who must ACT on an alert
              have no account and never will — a plant QA lead who renews one
              certificate a year, whoever is on the out-of-spec list. Their
              whole experience is the email plus this one link. Read-only, no
              shell, no nav; the per-alert token in the URL is the gate and the
              server projects onto a hard allow-list. */}
          <Route path="/alert/:token" element={<AlertLanding />} />

          {/* The supplier's side of a document request. No account, no
              password: the token is the gate, exactly as /alert/ and /u/ do it. */}
          <Route path="/r/:token" element={<SupplierRequestPortal />} />

          {/* Phase B4 — public drop link. Vendors land here from a
              tenant-shared URL; the link token is the auth, the
              page renders an upload form, and submissions POST to
              the existing /api/sources/:slug/drop endpoint with
              the token as the bearer. No app shell, no login. */}
          <Route path="/drop/:slug/:token" element={<PublicDrop />} />

          {/* Phase D5 — vendor-facing public docs. Tenant admins
              share this URL with their vendors so they have a
              single canonical reference for every connector
              delivery door (email, API, S3, public link, manual).
              No auth, no app shell — pure documentation. */}
          <Route path="/docs/connectors" element={<PublicDocsConnectors />} />

          {/* Protected routes with layout — one per row of SURFACES. */}
          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              {SURFACES.map((surface) => (
                <Route
                  key={surface.path}
                  path={surface.path}
                  element={
                    surface.roles ? (
                      <ProtectedRoute roles={surface.roles}>{surface.element}</ProtectedRoute>
                    ) : (
                      surface.element
                    )
                  }
                />
              ))}
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
