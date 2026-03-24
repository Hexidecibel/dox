export const typeDefs = /* GraphQL */ `
type Tenant {
  id: ID!
  name: String!
  slug: String!
  description: String
  active: Boolean!
  createdAt: String!
  updatedAt: String!
  documents: [Document!]!
  users: [User!]!
}

type User {
  id: ID!
  email: String!
  name: String!
  role: Role!
  tenant: Tenant
  tenantId: String
  active: Boolean!
  lastLoginAt: String
  createdAt: String!
}

enum Role {
  SUPER_ADMIN
  ORG_ADMIN
  USER
  READER
}

type Document {
  id: ID!
  title: String!
  description: String
  category: String
  tags: [String!]!
  currentVersion: Int!
  status: DocumentStatus!
  tenantId: String!
  tenant: Tenant
  createdBy: User!
  versions: [DocumentVersion!]!
  externalRef: String
  sourceMetadata: String
  createdAt: String!
  updatedAt: String!
}

enum DocumentStatus {
  ACTIVE
  ARCHIVED
  DELETED
}

type DocumentVersion {
  id: ID!
  versionNumber: Int!
  fileName: String!
  fileSize: Int!
  mimeType: String!
  checksum: String
  changeNotes: String
  uploadedBy: User!
  createdAt: String!
}

type AuditEntry {
  id: ID!
  user: User
  action: String!
  resourceType: String
  resourceId: String
  details: String
  ipAddress: String
  createdAt: String!
}

type SearchResult {
  documents: [Document!]!
  total: Int!
}

type AuditResult {
  entries: [AuditEntry!]!
  total: Int!
}

type AuthPayload {
  token: String!
  user: User!
}

type ReportRow {
  title: String!
  category: String
  tags: String!
  status: String!
  currentVersion: Int!
  fileName: String
  fileSizeKB: Int!
  uploadedBy: String
  createdDate: String!
  lastUpdated: String!
}

type ReportResult {
  data: [ReportRow!]!
  total: Int!
}

type ResetPasswordResult {
  temporaryPassword: String!
  emailSent: Boolean!
}

type Query {
  me: User!
  tenants: [Tenant!]!
  tenant(id: ID!): Tenant
  users(tenantId: ID): [User!]!
  user(id: ID!): User
  documents(tenantId: ID, category: String, status: DocumentStatus, limit: Int, offset: Int): [Document!]!
  document(id: ID!): Document
  lookupDocument(externalRef: String!, tenantId: ID!): Document
  searchDocuments(query: String!, tenantId: ID, category: String, limit: Int, offset: Int): SearchResult!
  auditLog(tenantId: ID, action: String, userId: ID, resourceType: String, dateFrom: String, dateTo: String, limit: Int, offset: Int): AuditResult!
}

type Mutation {
  login(email: String!, password: String!): AuthPayload!
  logout: Boolean!
  changePassword(currentPassword: String!, newPassword: String!): Boolean!
  createTenant(name: String!, slug: String, description: String): Tenant!
  updateTenant(id: ID!, name: String, description: String, active: Boolean): Tenant!
  deleteTenant(id: ID!): Boolean!
  createUser(email: String!, name: String!, password: String!, role: Role!, tenantId: ID): User!
  updateUser(id: ID!, name: String, role: Role, active: Boolean, tenantId: ID): User!
  deleteUser(id: ID!): Boolean!
  resetUserPassword(id: ID!): ResetPasswordResult!
  createDocument(title: String!, description: String, category: String, tags: [String!], tenantId: ID!): Document!
  updateDocument(id: ID!, title: String, description: String, category: String, tags: [String!], status: DocumentStatus): Document!
  deleteDocument(id: ID!): Boolean!
  generateReport(tenantId: ID, category: String, dateFrom: String, dateTo: String): ReportResult!
}
`;
