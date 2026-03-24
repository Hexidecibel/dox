// Re-export frontend-friendly types from shared
export type { Role, DocumentStatus } from '../../shared/types';
export type { User, Tenant, Document, DocumentVersion, AuthPayload } from '../../shared/types';
export type {
  ApiDocument,
  ApiDocumentVersion,
  ApiUser,
  ApiTenant,
  ApiAuditEntry,
  LoginResponse,
  RegisterResponse,
  DocumentListResponse,
  DocumentGetResponse,
  DocumentCreateResponse,
  DocumentUpdateResponse,
  DocumentVersionsResponse,
  DocumentUploadResponse,
  SearchResponse,
  AuditListResponse,
  ResetPasswordResponse,
  IngestResponse,
  LookupResponse,
  ApiKey,
  CreateApiKeyResponse,
} from '../../shared/types';
export { AUTH_TOKEN_KEY, AUTH_USER_KEY } from '../../shared/types';
