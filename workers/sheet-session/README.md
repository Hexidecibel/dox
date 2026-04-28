# dox-sheet-session

Standalone Cloudflare Worker that hosts the `SheetSession` Durable Object
class. Cloudflare Pages cannot host DO classes directly, so the Pages
project (`doc-upload-site` / `doc-upload-site-staging`) binds to this
Worker by name via `script_name` in its own `wrangler.toml`.

The default `fetch` handler returns a 404 — direct HTTP traffic is never
expected. The Worker is invoked only via DO RPC from Pages
(`env.SHEET_SESSION.idFromName(...)` -> `stub.fetch(...)`).

## Deploy

```bash
# Production
npx wrangler deploy

# Staging
npx wrangler deploy --config wrangler.staging.toml
```

The staging Worker (`dox-sheet-session-staging`) must be deployed before
the staging Pages site, or the Pages binding will fail to resolve at
request time. Same rule applies to prod.

DO class migrations (`[[migrations]]`) live in this Worker's
`wrangler.toml` — never in the Pages config.
