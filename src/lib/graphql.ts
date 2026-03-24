const GRAPHQL_ENDPOINT = '/api/graphql';

/**
 * Lightweight fetch-based GraphQL client.
 * Automatically attaches JWT from localStorage if present.
 */
export async function gql<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const token = localStorage.getItem('token');
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (json.errors) {
    throw new Error(json.errors[0].message);
  }

  return json.data as T;
}

/** Pre-built query strings for common operations. */
export const QUERIES = {
  ME: `query { me { id email name role tenantId } }`,

  DOCUMENTS: `query Documents($tenantId: ID, $category: String, $status: DocumentStatus, $limit: Int, $offset: Int) {
    documents(tenantId: $tenantId, category: $category, status: $status, limit: $limit, offset: $offset) {
      id title description category tags currentVersion status createdAt updatedAt
      createdBy { id name }
    }
  }`,

  DOCUMENT: `query Document($id: ID!) {
    document(id: $id) {
      id title description category tags currentVersion status createdAt updatedAt
      createdBy { id name }
      tenant { id name }
      versions { id versionNumber fileName fileSize mimeType checksum changeNotes createdAt uploadedBy { id name } }
    }
  }`,

  SEARCH: `query Search($query: String!, $tenantId: ID, $category: String, $limit: Int, $offset: Int) {
    searchDocuments(query: $query, tenantId: $tenantId, category: $category, limit: $limit, offset: $offset) {
      documents { id title description category tags currentVersion status createdAt createdBy { id name } }
      total
    }
  }`,

  TENANTS: `query { tenants { id name slug description active createdAt } }`,

  USERS: `query Users($tenantId: ID) { users(tenantId: $tenantId) { id email name role tenantId active createdAt } }`,

  AUDIT_LOG: `query AuditLog($tenantId: ID, $action: String, $userId: ID, $resourceType: String, $dateFrom: String, $dateTo: String, $limit: Int, $offset: Int) {
    auditLog(tenantId: $tenantId, action: $action, userId: $userId, resourceType: $resourceType, dateFrom: $dateFrom, dateTo: $dateTo, limit: $limit, offset: $offset) {
      entries { id action resourceType resourceId details ipAddress createdAt user { id name email } }
      total
    }
  }`,
};

/** Pre-built mutation strings for common operations. */
export const MUTATIONS = {
  LOGIN: `mutation Login($email: String!, $password: String!) {
    login(email: $email, password: $password) { token user { id email name role tenantId } }
  }`,

  CHANGE_PASSWORD: `mutation ChangePassword($currentPassword: String!, $newPassword: String!) {
    changePassword(currentPassword: $currentPassword, newPassword: $newPassword)
  }`,

  CREATE_DOCUMENT: `mutation CreateDoc($title: String!, $description: String, $category: String, $tags: [String!], $tenantId: ID!) {
    createDocument(title: $title, description: $description, category: $category, tags: $tags, tenantId: $tenantId) { id title }
  }`,

  UPDATE_DOCUMENT: `mutation UpdateDoc($id: ID!, $title: String, $description: String, $category: String, $tags: [String!], $status: DocumentStatus) {
    updateDocument(id: $id, title: $title, description: $description, category: $category, tags: $tags, status: $status) { id title status }
  }`,

  DELETE_DOCUMENT: `mutation DeleteDoc($id: ID!) { deleteDocument(id: $id) }`,

  CREATE_TENANT: `mutation CreateTenant($name: String!, $slug: String, $description: String) {
    createTenant(name: $name, slug: $slug, description: $description) { id name slug }
  }`,

  UPDATE_TENANT: `mutation UpdateTenant($id: ID!, $name: String, $description: String, $active: Boolean) {
    updateTenant(id: $id, name: $name, description: $description, active: $active) { id name slug active }
  }`,

  CREATE_USER: `mutation CreateUser($email: String!, $name: String!, $password: String!, $role: Role!, $tenantId: ID) {
    createUser(email: $email, name: $name, password: $password, role: $role, tenantId: $tenantId) { id email name }
  }`,

  UPDATE_USER: `mutation UpdateUser($id: ID!, $name: String, $role: Role, $active: Boolean, $tenantId: ID) {
    updateUser(id: $id, name: $name, role: $role, active: $active, tenantId: $tenantId) { id email name role active }
  }`,

  LOGOUT: `mutation { logout }`,

  DELETE_TENANT: `mutation DeleteTenant($id: ID!) { deleteTenant(id: $id) }`,

  DELETE_USER: `mutation DeleteUser($id: ID!) { deleteUser(id: $id) }`,

  RESET_USER_PASSWORD: `mutation ResetUserPassword($id: ID!) {
    resetUserPassword(id: $id) { temporaryPassword emailSent }
  }`,

  GENERATE_REPORT: `mutation GenerateReport($tenantId: ID, $category: String, $dateFrom: String, $dateTo: String) {
    generateReport(tenantId: $tenantId, category: $category, dateFrom: $dateFrom, dateTo: $dateTo) {
      data { title category tags status currentVersion fileName fileSizeKB uploadedBy createdDate lastUpdated }
      total
    }
  }`,
};
