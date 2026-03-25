```
   ___  _____  __
  / _ \/ _ \ \/ /
 / // / ___/\  /
/____/\___/ /_/
```

### 📄 Document management that doesn't suck.

Multi-tenant document portal with version tracking, role-based access, audit logging, and an API that actually makes sense. Built on Cloudflare's edge stack — fast everywhere, cheap to run.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## ✨ Features

| | Feature | What it does |
|---|---------|-------------|
| 🏢 | **Multi-tenant** | Each org gets isolated docs, users, and audit trails |
| 🔐 | **4-tier RBAC** | super_admin → org_admin → user → reader |
| 📝 | **Version tracking** | Full history for every document, never lose a revision |
| 👀 | **Inline preview** | PDFs, images, CSV, and text render right in the browser |
| 🔍 | **Full-text search** | Search titles, descriptions, tags, filenames, and PDF content |
| 🔌 | **REST + GraphQL** | Dual API surface — use whichever fits your workflow |
| 🤖 | **Ingestion API** | Upsert endpoint for agentic AI pipelines and email automation |
| 🔑 | **API keys** | Programmatic access with `dox_sk_` prefixed keys |
| 📊 | **Reports** | CSV and JSON exports on demand |
| 📋 | **Audit log** | Every action tracked with diffs — who did what, when |
| 📧 | **Email notifications** | Invitations and password resets via Resend |
| 🌍 | **Edge-native** | Runs on Cloudflare Workers — sub-50ms responses globally |

---

## 🏗️ Architecture

```
Browser ──→ Cloudflare Pages
                │
                ├── Static assets (React + Vite)
                │
                └── Pages Functions (Workers)
                       │
                       ├── D1 (SQLite at the edge)
                       ├── R2 (file storage)
                       └── Resend (email)
```

| Layer | Tech |
|-------|------|
| Frontend | React 18 + MUI 6 + Vite |
| Backend | Cloudflare Pages Functions |
| Database | Cloudflare D1 (SQLite) |
| Storage | Cloudflare R2 |
| Auth | JWT (HMAC-SHA256) + PBKDF2 passwords |
| Email | Resend API |

---

## 🚀 Quick Start

You'll need [Node.js 18+](https://nodejs.org/) and a [Cloudflare account](https://dash.cloudflare.com/sign-up) with D1 and R2 enabled.

### 1. Clone & install

```bash
git clone <your-repo-url>
cd dox
npm install
```

### 2. Set up Cloudflare resources

```bash
# Install wrangler if you haven't
npm install -g wrangler
wrangler login

# Create your D1 database and R2 bucket
wrangler d1 create dox-db
wrangler r2 bucket create dox-files
```

### 3. Configure

```bash
# Copy the example configs
cp wrangler.toml.example wrangler.toml
cp .env.example .dev.vars
```

Edit `wrangler.toml` — paste your D1 database ID from step 2:
```toml
database_id = "your-d1-id-from-above"
```

Edit `.dev.vars` — set your JWT secret:
```bash
# Generate a secure secret
openssl rand -hex 32
```

```
JWT_SECRET=<paste-your-secret>
RESEND_API_KEY=re_xxxx  # Optional — needed for email features
```

### 4. Run migrations & seed

```bash
npm run migrate
./bin/seed
```

This creates the database tables and a default super_admin account.

### 5. Launch! 🎉

```bash
npm run dev
```

Open [http://localhost:8788](http://localhost:8788) — log in with the seeded admin, change your password, and you're rolling.

---

## 👥 Roles

| Role | Scope | What they can do |
|------|-------|-----------------|
| 🛡️ **super_admin** | All tenants | Everything — manage orgs, users, all docs |
| 🏢 **org_admin** | Own tenant | Manage their org's users and documents |
| ✏️ **user** | Own tenant | Create, upload, update, delete documents |
| 👁️ **reader** | Own tenant | View and download only |

---

## 📖 API

Full API documentation:

- **[`openapi.yaml`](openapi.yaml)** — OpenAPI 3.1 spec (import into Postman, Insomnia, etc.)
- **[`API.md`](API.md)** — Human-readable guide with curl examples

Quick taste:

```bash
# Login
curl -X POST http://localhost:8788/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "your-password"}'

# List documents (with JWT)
curl http://localhost:8788/api/documents \
  -H "Authorization: Bearer <your-token>"

# Or use an API key
curl http://localhost:8788/api/documents \
  -H "X-API-Key: dox_sk_your_key_here"
```

---

## 🛠️ Scripts

| Command | What it does |
|---------|-------------|
| `npm run dev` | Full dev server (backend + frontend) on :8788 |
| `npm run dev:frontend` | Vite HMR only (frontend dev) |
| `npm run build` | Production build |
| `npm run migrate` | Run D1 migrations locally |
| `npm run migrate:remote` | Run D1 migrations in production |
| `./bin/deploy` | Build + deploy to Cloudflare Pages |
| `./bin/seed` | Seed the admin user |

---

## 🚢 Deploying to Production

```bash
./bin/deploy
```

Production secrets are set via Wrangler (the deploy script handles this):
```bash
wrangler pages secret put JWT_SECRET
wrangler pages secret put RESEND_API_KEY  # Optional
```

---

## 🤝 Contributing

1. Fork it
2. Create your feature branch (`git checkout -b my-feature`)
3. Make your changes
4. Run `npm run build` to make sure nothing's broken
5. Commit and push
6. Open a PR

---

## 📄 License

[MIT](LICENSE) — do whatever you want with it.
