# Lessons Learned

## Local D1 database gotcha (2026-03-31)

`wrangler pages dev --d1 DB=doc-upload-db` and `wrangler d1 execute doc-upload-db` use DIFFERENT SQLite files under `.wrangler/state/v3/d1/`. Migrations run via `wrangler d1 execute` won't be visible to the dev server. To fix: either copy the migrated DB file over, or update the SQLite file directly at `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite`.

## Seed admin password (2026-03-31)

`bin/seed` sets `password_hash = 'CHANGE_ME_VIA_APP'` which is not a valid PBKDF2 hash and causes 500 on login. Must generate a real hash (PBKDF2, 16-byte salt, 100000 iterations, SHA-256, 256-bit key, stored as `salt_hex:hash_hex`) and update the DB directly.

## Variable scoping in try/catch (2026-03-31)

`let` variables declared inside `try {}` are NOT accessible in the `catch {}` block. If you need tracking variables for error logging, declare them BEFORE the `try` block. The inner `catch {}` that swallows audit logging errors will silently hide the ReferenceError.

## Cloudflare Pages auto-deploy (2026-03-31)

Git push to origin doesn't automatically trigger Cloudflare Pages builds for this project. Must manually build and deploy: `npm run build && npx wrangler pages deploy dist --project-name doc-upload-site --branch master`.

## JSON endpoint field types (2026-03-31)

For JSON endpoints (like ingest-url), accept fields as both native JSON types AND stringified JSON. Callers (like MindStudio) naturally send `tags: ["coa"]` not `tags: "[\"coa\"]"`. Also treat empty strings as null for optional fields — callers often send `""` instead of omitting the field.
