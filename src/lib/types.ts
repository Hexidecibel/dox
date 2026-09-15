// Import types used locally in this file
import type { TemplateFieldMapping } from '../../shared/types';

// Re-export frontend-friendly types from shared
export type { Role, DocumentStatus, RenewalType, ApiDocumentCategory } from '../../shared/types';
export type { User, Tenant, Document, DocumentVersion, AuthPayload, Assignment } from '../../shared/types';
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
  DocumentLinkedLot,
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
  // Registry vocabulary admin (migration 0080)
  ApiRequirement,
  ApiClaimType,
  // Registry facet links on a document (migration 0080)
  ApiDocumentRequirement,
  ApiDocumentClaim,
  DocumentFacetLinkInput,
  RegistryLinkStatus,
  RegistryLinkSource,
  ClaimSubjectType,
  ApiClaimRule,
  ClaimSubjectGrain,
  RequirementListResponse,
  RequirementGetResponse,
  ClaimTypeListResponse,
  ClaimTypeGetResponse,
  ClaimRuleListResponse,
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
  SupplierDuplicateMember,
  SupplierDuplicateCluster,
  SupplierDuplicatesResponse,
  SupplierMergeResponse,
  SupplierRow,
  LotScheme,
  SupplierLotSchemeResponse,
  SupplierLotSchemeVersion,
  ProductMapEntry,
  OrderProductOption,
  ProductMapGetResponse,
  ProductMapPutResponse,
  OrderProductListResponse,
  TemplateFieldMapping,
  ExtractionTemplateRow,
  SupplierExtractionInstructions,
  SupplierExtractionInstructionsGetResponse,
  SupplierExtractionInstructionsPutResponse,
  SupplierExtractionInstructionsListRow,
  SupplierExtractionInstructionsListResponse,
  DocumentTypeExtractionInstructions,
  DocumentTypeExtractionInstructionsGetResponse,
  DocumentTypeExtractionInstructionsListRow,
  DocumentTypeExtractionInstructionsListResponse,
  DocumentTypeExtractionInstructionsPutResponse,
  DocumentTypeInstructionsSupplierOverride,
  TeachSession,
  TeachMessage,
  TeachExample,
  TeachProposal,
  TeachSessionStatus,
  TeachMessageRole,
  TeachSessionCreateResponse,
  TeachMessageResponse,
  TeachSynthesizeResponse,
  TeachSessionDetailResponse,
  TeachConfirmResponse,
  TeachSessionSummary,
  TeachSessionListResponse,
  ActivityEvent,
  ActivityEventType,
  ActivitySourceFilter,
  ActivityStatusFilter,
  ActivityConnectorRunEvent,
  ActivityDocumentIngestEvent,
  ActivityOrderCreatedEvent,
  ActivityAuditEvent,
  ActivityFilters,
  ActivityListResponse,
  ActivityEventDetailResponse,
  SavedSearch,
  CreateSavedSearchRequest,
  UpdateSavedSearchRequest,
  SavedSearchListResponse,
  SavedSearchResponse,
  UniversalSearchParams,
  UniversalSearchResponse,
  UniversalSearchBlock,
  UniversalSearchDocument,
  UniversalSearchSupplier,
  UniversalSearchProduct,
  UniversalSearchDocType,
  UniversalSearchOrder,
  UniversalSearchCustomer,
  UniversalSearchBundle,
  LotListItem,
  LotListResponse,
  LotCoaDocument,
  LotOrderLine,
  LotSuggestion,
  LotDetail,
  CoaGapStatus,
  CoaAvailability,
  CoaFulfillmentRow,
  CoaFulfillmentSummary,
  CoaFulfillmentResponse,
  ExpirationStatus,
  ExpirationRow,
  ExpirationSummary,
  ExpirationListResponse,
  ExpirationNotifyResponse,
  LotMatchSuggestion,
  LotMatchListResponse,
  CoaRecordCardinality,
  CoaRecordKeyBasis,
  CoaResultCell,
  CoaRecord,
  CoaRecordsPayload,
  CoaRecordDecision,
  InvariantFailure,
  InvariantCheck,
  SpecVerdict,
  SpecVerdictKind,
  SpecTarget,
  SpecCriticality,
  ApiSpecTest,
  ApiSpecLimit,
  ApiSpecCheck,
  ApiRequiredAnalyte,
  ApiSpecGap,
  UnjudgedResult,
  MissingRequiredAnalyte,
  OverdueWatchSummary,
  UnitConversion,
  RejectionReason,
  NoteEntityType,
  EntityNote,
  NoteListResponse,
  NoteGetResponse,
  OwnerRoute,
  OwnerLabelInUse,
  OwnerRouteListResponse,
  // Supplier applicability — what a supplier owes (migration 0087)
  SupplierRequirementTier,
  SupplierRequirementRow,
  ApiSupplierRequirement,
} from '../../shared/types';
export { AUTH_TOKEN_KEY, AUTH_USER_KEY } from '../../shared/types';
// Value exports (not types): the rejection-reason enum + its reviewer-facing
// labels, so the reject dialog and the API stay in lockstep.
export { REJECTION_REASONS, REJECTION_REASON_LABELS, ATTENTION_REASON_PRESETS } from '../../shared/types';
export { parseCoaRecords } from '../../shared/types';
// Value export: the notes entity-type list, so a component and the API agree.
export { NOTE_ENTITY_TYPES } from '../../shared/types';

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

// Requirement gap detection (shared/requirementGap.ts). Re-exported here so
// components import gap shapes the same way they import every other API type.
export type {
  GapOrigin,
  GapCaveat,
  GapCaveatCode,
  GapRequirement,
  GapRollup,
  SupplierGap,
  SupplierGapCounts,
  SupplierGapStatus,
  SupplierGapListResponse,
  SupplierGapGetResponse,
  ClassificationCounts,
} from '../../shared/requirementGap';

// ---------------------------------------------------------------------------
// The request composer (migration 0090) — composing, issuing, amending and
// re-issuing an ask, plus saved templates.
//
// Re-exported here for the same reason as everything above: `src/` imports its
// API shapes from one place, and a type that reaches shared/types.ts and
// api.ts but not this file compiles under tsc and breaks `npm run build`.
// ---------------------------------------------------------------------------
export type {
  DocumentRequestStatus,
  DocumentRequestOrigin,
  RequestLineKind,
  RequestLineStatus,
  RequestIssueChannel,
  RequestLineRow,
  RequestLineClosure,
  RequestLineWithClosure,
  DocumentRequestRow,
  RequestRoutingRow,
  DocumentRequestLineCounts,
  DocumentRequestDetail,
  DocumentRequestVersionSummary,
  DocumentRequestListItem,
  DocumentRequestListResponse,
  DocumentRequestResponse,
  RequestLinkView,
  SupplierRequestView,
  RequestArrivalPipelineState,
  RequestArrivalClaim,
  RequestArrivalDocument,
  RequestArrival,
  RequestArrivalListResponse,
  RequestArrivalResponse,
  RequestArrivalDecisionKind,
  DecideArrivalLine,
  DecideArrivalRequest,
  DecideArrivalResponse,
  QueueArrivalDecisionInput,
  QueueArrivalDecisionOutcome,
  SupplierRequestItem,
  RequestLineInput,
  CreateDocumentRequestRequest,
  IssueDocumentRequestRequest,
  AmendDocumentRequestRequest,
  ReissueDocumentRequestRequest,
  RequestTemplateRow,
  RequestTemplateLineRow,
  RequestTemplateDetail,
  RequestTemplateListResponse,
  RequestTemplateResponse,
  CreateRequestTemplateRequest,
  InstantiateRequestTemplateRequest,
  UpdateRequestLineRequest,
} from '../../shared/types';

// The external supplier request page (/r/:token). Appended here rather than
// merged into the block above because `shared/types.ts` is being edited
// concurrently — and because a type that reaches `src/` without a re-export
// through this file compiles under tsc and fails only at `npm run build`.
export type {
  SupplierRequestProgress,
  SupplierRequestUpload,
  SupplierUploadResult,
} from '../../shared/types';

// Value exports: the two status vocabularies, so a filter control and the API
// cannot drift apart.
export {
  DOCUMENT_REQUEST_STATUSES,
  REQUEST_LINE_STATUSES,
} from '../../shared/types';

// Modules (migration 0099). The vocabulary lives in `shared/modules.ts` and
// nowhere else; `shared/types.ts` re-exports `ModuleKey` and adds the API
// envelopes around it, which the nav, the router and the Settings screen all
// read.
export type {
  ModuleKey,
  ModuleSummary,
  ModuleListResponse,
  UpdateModuleRequest,
  ModuleUpdateResponse,
  ModuleVisibilityFunction,
  ModuleVisibilityResponse,
  UpdateModuleVisibilityRequest,
  ModuleVisibilityUpdateResponse,
  ModuleAccessResponse,
} from '../../shared/types';

// Value export: the module vocabulary itself, so a screen that renders one
// column per module iterates the same list the resolver does. Re-exported
// here rather than imported from `shared/modules.ts` all over `src/` for the
// same reason as above — one door out of `shared/`.
export { MODULE_KEYS, MODULES, isModuleKey } from '../../shared/modules';

// ---------------------------------------------------------------------------
// The first-run setup wizard (migration 0101).
//
// Re-exported here for the same reason as everything above: `src/` imports its
// API shapes from one place, and a type that reaches shared/types.ts and
// api.ts but not this file compiles under tsc and breaks `npm run build`.
// ---------------------------------------------------------------------------
export type {
  TenantSetupStatus,
  TenantSetupRun,
  TenantSetupApplied,
  TenantSetupPackApplication,
  TenantSetupNeedReason,
  TenantSetupResponse,
  TenantSetupRunResponse,
  CreateTenantSetupRequest,
  UpdateTenantSetupRequest,
  StarterPackSection,
  StarterPackCatalogEntry,
  StarterPackCatalogResponse,
  ApplyStarterPackRequest,
  ApplyStarterPackResponse,
  StarterPackPacket,
  ApplyRequirementPacketRequest,
  ApplyRequirementPacketResponse,
  DocumentTypeRequirementRow,
  DocumentTypeRequirementsResponse,
  ReplaceDocumentTypeRequirementsRequest,
  ReplaceDocumentTypeRequirementsResponse,
} from '../../shared/types';

// Value export: how many screens the wizard has, so the stepper and the
// server-side clamp cannot disagree about what step 6 means.
export { TENANT_SETUP_STEPS } from '../../shared/types';
