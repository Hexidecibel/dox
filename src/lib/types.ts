// Import types used locally in this file
import type { TemplateFieldMapping } from '../../shared/types';

// Re-export frontend-friendly types from shared
export type { Role, DocumentStatus } from '../../shared/types';
export type { User, Tenant, Document, DocumentVersion, AuthPayload } from '../../shared/types';
export type {
  ApiDocument,
  ApiDocumentVersion,
  ApiUser,
  ApiTenant,
  ApiAuditEntry,
  ApiProduct,
  ApiDocumentType,
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
  ProductListResponse,
  ProductGetResponse,
  DocumentTypeListResponse,
  DocumentTypeGetResponse,
  ApiKey,
  CreateApiKeyResponse,
  ApiDocumentProduct,
  DocumentProductListResponse,
  ApiBundle,
  ApiBundleItem,
  BundleListResponse,
  BundleGetResponse,
  ProcessingResult,
  ProcessingResponse,
  ExtractedTable,
  ProductEntry,
  ExtractionExampleRow,
  ProcessingQueueItem,
  QueuedResponse,
  ParsedQuery,
  NaturalSearchResponse,
  OrderNaturalSearchResponse,
  ApiSupplier,
  SupplierListResponse,
  SupplierGetResponse,
  SupplierLookupOrCreateResponse,
  TemplateFieldMapping,
  ExtractionTemplateRow,
} from '../../shared/types';
export { AUTH_TOKEN_KEY, AUTH_USER_KEY } from '../../shared/types';

export interface ExtractionTemplate {
  id: string;
  tenant_id: string;
  supplier_id: string;
  document_type_id: string;
  field_mappings: TemplateFieldMapping[];
  auto_ingest_enabled: number;
  confidence_threshold: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  supplier_name?: string;
  document_type_name?: string;
}
