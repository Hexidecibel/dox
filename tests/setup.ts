// Global test setup — runs inside the Workers pool environment.
// Applies all migrations to the test D1 database before any tests execute.

import { env } from 'cloudflare:test';
import { runMigrations } from './helpers/db';

await runMigrations(env.DB);
