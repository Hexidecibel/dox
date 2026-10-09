/**
 * The Records module's tables (migrations 0040-0045), for a test that needs
 * them.
 *
 * They are NOT in the chain tests/helpers/db.ts applies to every test file --
 * the Records public surfaces had no tests before the tenant brand record --
 * so a file that reads a public form, an update request or a workflow approval
 * applies them itself, once, in its own `beforeAll`. Each test file has its own
 * database, so this touches nobody else.
 */
import { splitStatements } from './db';
import m0040 from '../../migrations/0040_records_core.sql?raw';
import m0041 from '../../migrations/0041_records_forms.sql?raw';
import m0042 from '../../migrations/0042_records_customer_ref.sql?raw';
import m0043 from '../../migrations/0043_records_form_attachments.sql?raw';
import m0044 from '../../migrations/0044_records_update_requests.sql?raw';
import m0045 from '../../migrations/0045_records_workflows.sql?raw';

const TOLERATED = ['already exists', 'duplicate column name'];

export async function applyRecordsMigrations(db: D1Database): Promise<void> {
  for (const sql of [m0040, m0041, m0042, m0043, m0044, m0045]) {
    for (const statement of splitStatements(sql)) {
      try {
        await db.prepare(statement).run();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (TOLERATED.some((t) => message.includes(t))) continue;
        throw new Error(`Records migration failed: ${message}\n${statement.slice(0, 160)}`);
      }
    }
  }
}
