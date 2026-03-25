# Document Portal

Multi-tenant document upload/download portal with version tracking, role-based access control, audit logging, and report generation. Built for regulatory document management where manufacturers and vendors independently manage their documents.

## Features

- **Multi-tenant isolation** — each organization has its own documents and users
- **4-tier RBAC** — super_admin, org_admin, user, reader roles
- **Document versioning** — full version history with file storage on R2
- **Inline preview** — PDF, images, CSV, and text files render in-browser
- **Dual API** — REST + GraphQL endpoints
- **API key access** — programmatic access for service integrations and automation
- **Document ingestion** — upsert endpoint for agentic/email pipelines
- **Audit logging** — every action tracked with diff details
- **Search** — full-text search across titles, descriptions, tags, and filenames
- **Report generation** — CSV and JSON exports
- **Password management** — forgot/reset flow with email notifications
- **Email notifications** — invitation and password reset emails via Resend

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Cloudflare Pages Functions (Workers) |
| Database | Cloudflare D1 (SQLite at the edge) |
| File Storage | Cloudflare R2 |
| Frontend | React 18 + MUI 6 + React Router + Vite |
| Auth | Custom JWT (HMAC-SHA256, PBKDF2 passwords) |
| Email | Resend API |
| GraphQL | graphql-yoga |

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Cloudflare account with D1 and R2 enabled

## Setup

1. **Clone and install dependencies:**

   ```bash
   git clone <repo-url>
   cd doc-upload-site
   npm install
   ```

2. **Configure Wrangler:**

   ```bash
   cp wrangler.toml.example wrangler.toml
   ```

   Edit `wrangler.toml` and fill in your D1 database ID. To create the D1 database and R2 bucket:

   ```bash
   wrangler d1 create doc-upload-db
   wrangler r2 bucket create doc-upload-files
   ```

3. **Configure environment variables:**

   ```bash
   cp .env.example .dev.vars
   ```

   Edit `.dev.vars` and set:
   - `JWT_SECRET` — generate with `openssl rand -hex 32`
   - `RESEND_API_KEY` — (optional) get from [resend.com](https://resend.com) for email notifications

4. **Run migrations:**

   ```bash
   npm run migrate
   ```

5. **Seed the admin user:**

   ```bash
   ./bin/seed
   ```

   This creates a super_admin user. Log in and change the password immediately.

6. **Start the dev server:**

   ```bash
   npm run dev
   ```

   The app will be available at `http://localhost:8788`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start full dev server (Wrangler + Vite) on port 8788 |
| `npm run dev:frontend` | Start Vite HMR only (frontend dev) |
| `npm run build` | Build for production (TypeScript + Vite) |
| `npm run migrate` | Run D1 migrations locally |
| `npm run migrate:remote` | Run D1 migrations on production |
| `./bin/deploy` | Deploy to Cloudflare Pages |
| `./bin/seed` | Seed admin user |

## Role Model

| Role | Scope | Permissions |
|------|-------|-------------|
| super_admin | All tenants | Full access, manage tenants and all users |
| org_admin | Own tenant | Manage users, documents, view audit logs |
| user | Own tenant | Create, upload, update, delete documents |
| reader | Own tenant | Read-only access, download files |

## API Documentation

- **`openapi.yaml`** — OpenAPI 3.1 spec for all REST endpoints
- **`API.md`** — Human-readable API guide with examples

## Deployment

```bash
./bin/deploy
```

This builds the project and deploys to Cloudflare Pages. Production secrets (`JWT_SECRET`, `RESEND_API_KEY`) are managed via `wrangler pages secret put`.

## License

[MIT](LICENSE)
