/**
 * Factory functions returning test data objects with sensible defaults.
 * Spread overrides to customize specific fields.
 */

let counter = 0;
function nextId(): string {
  counter++;
  return `test-${counter.toString().padStart(6, '0')}`;
}

export function resetFixtureCounter() {
  counter = 0;
}

export const fixtures = {
  tenant(overrides: Record<string, unknown> = {}) {
    const id = nextId();
    return {
      id,
      name: `Tenant ${id}`,
      slug: `tenant-${id}`,
      description: null,
      active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  },

  user(overrides: Record<string, unknown> = {}) {
    const id = nextId();
    return {
      id,
      email: `user-${id}@example.com`,
      name: `User ${id}`,
      role: 'user' as const,
      tenant_id: 'test-tenant-id',
      active: 1,
      password_hash: 'placeholder-hash',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  },

  document(overrides: Record<string, unknown> = {}) {
    const id = nextId();
    return {
      id,
      tenant_id: 'test-tenant-id',
      title: `Document ${id}`,
      description: null,
      category: null,
      tags: '[]',
      current_version: 1,
      status: 'active' as const,
      created_by: 'test-user-id',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  },

  customer(overrides: Record<string, unknown> = {}) {
    const id = nextId();
    return {
      id,
      tenant_id: 'test-tenant-id',
      customer_number: `C${id}`,
      name: `Customer ${id}`,
      email: null,
      phone: null,
      address: null,
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  },

  order(overrides: Record<string, unknown> = {}) {
    const id = nextId();
    return {
      id,
      tenant_id: 'test-tenant-id',
      order_number: `ORD-${id}`,
      po_number: null,
      customer_id: null,
      connector_id: null,
      status: 'pending' as const,
      source_data: '{}',
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  },

  connector(overrides: Record<string, unknown> = {}) {
    const id = nextId();
    return {
      id,
      tenant_id: 'test-tenant-id',
      name: `Connector ${id}`,
      type: 'email' as const,
      config: '{}',
      credentials_encrypted: null,
      credentials_iv: null,
      field_mappings: '{}',
      active: 1,
      last_run_at: null,
      last_error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  },
};
