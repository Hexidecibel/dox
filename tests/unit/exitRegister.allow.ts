/**
 * THE EXIT REGISTER -- every file under functions/ that can reach stored
 * files, whether a document can LEAVE through it, and exactly how much it
 * touches storage.
 *
 * tests/unit/exitRegister.test.ts fails when a file that names the bucket (the
 * `FILES` binding, the `R2Bucket` type, a read wrapper, or a storage call on a
 * name some file declares as a bucket) is not listed here, AND when a listed
 * file's `signature` no longer matches the code. So a new way out of the
 * portal cannot be added quietly -- not in a new file, and not as one more
 * read inside a file that is already listed.
 *
 *   exit      The bytes of an approved DOCUMENT can reach a person or a system
 *             through this file. It must ask the sharing rule (decision C-003,
 *             migration 0137); `checked_by` names the function it asks
 *             through. When it makes more reads than it has checks,
 *             `reads_covered_by` says which check covers which read.
 *
 *   not_exit  The file touches storage some other way: it writes INTO it, it
 *             moves a queued file, the bytes are not an approved document's,
 *             or it only passes the bucket along. Say which.
 *
 * `signature` is what tests/unit/exitRegister.scan.ts counts in the file,
 * outside comments:
 *
 *   bucket    mentions of `FILES` or `R2Bucket`
 *   gets      `.get(` calls on any receiver except `.headers` / `.searchParams`
 *   readers   calls to downloadFile / readExportBytes / buildExportZip
 *   checks    calls to the sharing-rule functions below
 *
 * WHEN THE TEST SAYS A SIGNATURE MOVED: do not just paste the new numbers.
 * Find the line that moved them. A new read in an `exit` needs its own rule
 * check; a new read in a `not_exit` may have made it an exit. Then update the
 * numbers, and the reason if it no longer holds.
 */
import type { BucketSignature } from './exitRegister.scan';

export type ExitClassification = 'exit' | 'not_exit';

export interface ExitRegisterEntry {
  /** Repo-relative path, exact. */
  path: string;
  classification: ExitClassification;
  /** Why it is classified that way. */
  reason: string;
  /** Pinned. See the header. */
  signature: BucketSignature;
  /**
   * `exit` only: the sharing-rule function this file asks through. Must appear
   * in the file outside comments.
   */
  checked_by?: string;
  /**
   * `exit` only, required when `signature.readers > signature.checks`: which
   * check covers which read.
   */
  reads_covered_by?: string;
}

/** The functions that ask the sharing rule. An `exit` must name one of these. */
export const SHARING_RULE_CHECKS = [
  'apiKeyFileRefusal',
  'judgeDocumentsForExit',
  'judgeSharedFile',
  // Several files judged off one read (0139): the per-part check of an order send.
  'judgeSharedFiles',
  'loadExportDocuments',
  'loadExportLinkDocuments',
  'loadExportLinkSet',
] as const;

export const EXIT_REGISTER: ExitRegisterEntry[] = [
  // ---- exits -------------------------------------------------------------
  {
    path: 'functions/api/documents/[id]/download.ts',
    classification: 'exit',
    checked_by: 'apiKeyFileRefusal',
    signature: { bucket: 2, gets: 0, readers: 2, checks: 2 },
    reason:
      'One document file, and the packet original it was split from. A logged-in person is not asked; an API key reads "send freely" only (the packet: strictest rule of every document citing it).',
  },
  {
    path: 'functions/api/queue/[id]/file.ts',
    classification: 'exit',
    checked_by: 'apiKeyFileRefusal',
    signature: { bucket: 2, gets: 0, readers: 2, checks: 2 },
    reason:
      'Serves a queue item\'s staging object and, when that is gone, the approved document made from it. A waiting item with no documents is intake and is not asked; everything else is asked for an API key on BOTH reads.',
  },
  {
    path: 'functions/api/request-uploads/[id]/file.ts',
    classification: 'exit',
    checked_by: 'apiKeyFileRefusal',
    signature: { bucket: 2, gets: 0, readers: 2, checks: 1 },
    reason:
      'Serves a supplier arrival\'s own object, else the linked document\'s current version. Once the arrival has become a document an API key is asked, whichever of the two reads serves the bytes.',
    reads_covered_by:
      'ONE check before both reads: it runs whenever the arrival is linked to a document or its queue item produced any, and both downloadFile calls come after it. An arrival that is only an arrival is not a document and is not asked.',
  },
  {
    path: 'functions/api/bundles/[id]/download.ts',
    classification: 'exit',
    checked_by: 'judgeDocumentsForExit',
    signature: { bucket: 1, gets: 2, readers: 1, checks: 1 },
    reason:
      'The bundle ZIP. Every item is judged for the `bundle` exit; what is kept back, or missing from storage, is named in the archive, the headers and the audit row.',
  },
  {
    path: 'functions/api/document-exports/zip.ts',
    classification: 'exit',
    checked_by: 'loadExportDocuments',
    signature: { bucket: 1, gets: 0, readers: 1, checks: 1 },
    reason:
      'The search export ZIP. Its rows come only from loadExportDocuments, which judges the `zip` exit.',
  },
  {
    path: 'functions/api/document-exports/public/[token]/download.ts',
    classification: 'exit',
    checked_by: 'loadExportLinkSet',
    signature: { bucket: 1, gets: 0, readers: 1, checks: 1 },
    reason:
      'A recipient\'s ZIP from an emailed link. The rule is re-read on every request (`public_link`, on the minter\'s authority): a document locked since the send is left out.',
  },
  {
    path: 'functions/api/document-exports/public/[token]/file/[index].ts',
    classification: 'exit',
    checked_by: 'loadExportLinkDocuments',
    signature: { bucket: 1, gets: 1, readers: 0, checks: 1 },
    reason:
      'One file from an emailed link, addressed by position in the list the rule has already filtered (`public_link`).',
  },
  {
    path: 'functions/lib/document-export.ts',
    classification: 'exit',
    checked_by: 'judgeDocumentsForExit',
    signature: { bucket: 2, gets: 8, readers: 3, checks: 7 },
    reason:
      'Defines readExportBytes and buildExportZip, and loadExportDocuments, the one reader that produces the rows they read.',
    reads_covered_by:
      'The reader count is two DEFINITIONS (readExportBytes, buildExportZip) plus buildExportZip calling readExportBytes. None of them chooses what to read: every row reaches them from loadExportDocuments in this file, which will not return a row without an exit and an actor and calls judgeDocumentsForExit.',
  },
  {
    path: 'functions/lib/order-send.ts',
    classification: 'exit',
    checked_by: 'judgeSharedFile',
    signature: { bucket: 2, gets: 19, readers: 1, checks: 3 },
    reason:
      'CHECKS 4 -> 3, AND NO READ LOST ITS CHECK (0139 review): the plan asks loadExportDocuments and judgeSharedFile as before; the per-file check before the bytes are read is now ONE judgeSharedFiles call per part (every file of the part judged off one read) where it was judgeSharedFile per file; and the fourth, judgeDocumentsForExit in markDeliveredIfSent, is gone because "delivered" no longer asks the live rule at all -- it reads which documents actually left (C-090). The one new `.get(` is the Map lookup of a file\'s judgement by its id. ' +
      'An order\'s attachments, first send and resend. The plan judges each line (`order_send`), and runParts judges every stored file again immediately before its bytes are read. ' +
      'Document lines (0138) added seven `.get(` calls and NO read: all seven are Map lookups in the plan (the per-line outcome, the packed file by key, the entry by key, the gate\'s row and refusal by document id). ' +
      'A document line\'s file is never read here unless it is a certificate of analysis, which travels the same attachment path as a COA pick; every other document leaves on a link minted from ids that loadExportDocuments returned for this exit and this actor, and storedFileRefusal judges a link file exactly as it judges an attachment before the link is minted. `readers` and `checks` did not move. ' +
      'Three more `.get(` came with the resend fix (C-061), again all Map lookups and no read: a document line\'s state by id, a document\'s live facts by id, and the lines a file still stands for. They belong to documentLineFileVerdict, which runs BEFORE storedFileRefusal and can only take a file OUT of a resend.',
  },

  // ---- not exits ---------------------------------------------------------
  {
    path: 'functions/lib/r2.ts',
    classification: 'not_exit',
    signature: { bucket: 3, gets: 1, readers: 1, checks: 0 },
    reason:
      'Defines uploadFile, downloadFile and deleteFile. They act on a key they are handed; every caller is on this list in its own right.',
  },
  {
    path: 'functions/lib/types.ts',
    classification: 'not_exit',
    signature: { bucket: 2, gets: 0, readers: 0, checks: 0 },
    reason:
      'Declares the FILES binding on Env. A type, not a read.',
  },
  {
    path: 'functions/lib/graphql/context.ts',
    classification: 'not_exit',
    signature: { bucket: 2, gets: 0, readers: 0, checks: 0 },
    reason:
      'Puts the bucket on the GraphQL context. No resolver reads a file from it; one that did would be registered by the name `files`.',
  },
  {
    path: 'functions/lib/llm.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 0, readers: 0, checks: 0 },
    reason:
      'The word FILES appears in a prompt string ("document types this organisation FILES"). It never touches storage.',
  },
  {
    path: 'functions/lib/kinds/coa.ts',
    classification: 'not_exit',
    signature: { bucket: 4, gets: 2, readers: 3, checks: 0 },
    reason:
      'The approve paths: read the pending queue file to write it back to storage under a document version key. Nothing is returned to the caller.',
  },
  {
    path: 'functions/lib/queue-approve.ts',
    classification: 'not_exit',
    signature: { bucket: 2, gets: 0, readers: 0, checks: 0 },
    reason:
      'Passes the bucket through to the approve paths in kinds/coa.ts. Reads nothing itself.',
  },
  {
    path: 'functions/lib/packet-split.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 0, readers: 1, checks: 0 },
    reason:
      'Reads a packet in the Review Queue to cut it into parts, which are written back to storage as new queue items. Nothing leaves.',
  },
  {
    path: 'functions/lib/coa-original.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 4, readers: 0, checks: 0 },
    reason:
      'Checks with head() that a whole original is still in storage and how large it is. A size, never bytes; the read is in order-send.ts.',
  },
  {
    path: 'functions/lib/intake/duplicate-ledger.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 0, readers: 0, checks: 0 },
    reason:
      'Checks with head() that a duplicate arrival\'s file is still in storage before re-queuing it. A size, never bytes.',
  },
  {
    path: 'functions/lib/order-items.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 9, readers: 0, checks: 0 },
    reason:
      'Hands the bucket to coa-original.ts so an order line can say whether its whole original is on file. Reads nothing itself. (9th .get( since 0139: a Map lookup of the line\'s active hold, for display.)',
  },
  {
    path: 'functions/lib/connectors/pollR2.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 0, readers: 0, checks: 0 },
    reason:
      'Copies a file a connector found in a customer bucket INTO storage so the worker can read it. Intake, inbound only.',
  },
  {
    path: 'functions/api/queue/[id].ts',
    classification: 'not_exit',
    signature: { bucket: 3, gets: 4, readers: 0, checks: 0 },
    reason:
      'The Review Queue approve / reject route: passes the bucket to the approve paths, which move a pending file into a document version. Returns no file.',
  },
  {
    path: 'functions/api/queue/[id]/packet/split.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 0, readers: 0, checks: 0 },
    reason:
      'Passes the bucket to splitPacket, which cuts a queued packet into queued parts. Returns no file.',
  },
  {
    path: 'functions/api/intake-duplicates/[id]/review.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 0, readers: 0, checks: 0 },
    reason:
      'Passes the bucket to the duplicate ledger so a suppressed arrival can be put back in the Review Queue. Returns no file.',
  },
  {
    path: 'functions/api/orders/[id].ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 0, readers: 0, checks: 0 },
    reason:
      'Passes the bucket to loadOrderLines so each line can say whether its whole original is on file (a head, not a read). Returns no file.',
  },
  {
    path: 'functions/api/orders/[id]/send-preview.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 0, readers: 0, checks: 0 },
    reason:
      'Passes the bucket to planOrderSend, which checks sizes and judges the rule; it reads no bytes and sends nothing. The plan it prints is rule-checked in order-send.ts.',
  },
  {
    path: 'functions/api/orders/[id]/send.ts',
    classification: 'not_exit',
    signature: { bucket: 2, gets: 0, readers: 0, checks: 0 },
    reason:
      'Passes the bucket to planOrderSend and executeOrderSend. The reads, and both rule checks, are in functions/lib/order-send.ts, which is registered as the exit.',
  },
  {
    path: 'functions/api/orders/[id]/sends/[sendId]/resend.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 0, readers: 0, checks: 0 },
    reason:
      'Passes the bucket to resendFailedParts. The reads, and the re-check before each one, are in functions/lib/order-send.ts, which is registered as the exit.',
  },
  {
    path: 'functions/api/request-uploads/[id]/enqueue.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 1, readers: 0, checks: 0 },
    reason:
      'Reads a supplier arrival to hand it to the Review Queue. An arrival is not a document, and the bytes go into the queue, not to the caller.',
  },
  {
    path: 'functions/api/records/attachments/[attachmentId]/download.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 0, readers: 1, checks: 0 },
    reason:
      'A Records attachment is a file on a sheet row, not a registry document: it has no document type and so no sharing rule to ask. Tenant-gated.',
  },
  {
    path: 'functions/api/forms/public/[slug]/attachment/[attachmentId].ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 0, readers: 0, checks: 0 },
    reason:
      'Deletes a pending public-form attachment from storage. A delete, not a read.',
  },
  {
    path: 'functions/api/forms/public/[slug]/upload.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 1, readers: 0, checks: 0 },
    reason:
      'Writes a public-form attachment INTO storage. Inbound only.',
  },
  {
    path: 'functions/api/supplier-requests/public/[token]/upload.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 2, readers: 0, checks: 0 },
    reason:
      'Writes a supplier\'s uploaded file INTO storage. Inbound only.',
  },
  {
    path: 'functions/api/documents/[id]/upload.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 2, readers: 0, checks: 0 },
    reason:
      'Writes a new document version INTO storage. Inbound only.',
  },
  {
    path: 'functions/api/documents/ingest.ts',
    classification: 'not_exit',
    signature: { bucket: 2, gets: 29, readers: 0, checks: 0 },
    reason:
      'Writes an ingested file INTO storage as a document version. Inbound only.',
  },
  {
    path: 'functions/api/documents/ingest-url.ts',
    classification: 'not_exit',
    signature: { bucket: 2, gets: 0, readers: 0, checks: 0 },
    reason:
      'Fetches a file from a URL and writes it INTO storage as a document version. Inbound only.',
  },
  {
    path: 'functions/api/documents/process.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 6, readers: 0, checks: 0 },
    reason:
      'Writes an uploaded file INTO storage for the Review Queue. Inbound only.',
  },
  {
    path: 'functions/api/webhooks/email-ingest.ts',
    classification: 'not_exit',
    signature: { bucket: 2, gets: 6, readers: 0, checks: 0 },
    reason:
      'Writes an emailed attachment INTO storage for the Review Queue. Inbound only.',
  },
  {
    path: 'functions/api/webhooks/connector-email-ingest.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 0, readers: 0, checks: 0 },
    reason:
      'Writes a connector\'s emailed attachment INTO storage. Inbound only.',
  },
  {
    path: 'functions/api/sources/discover-schema.ts',
    classification: 'not_exit',
    signature: { bucket: 2, gets: 3, readers: 0, checks: 0 },
    reason:
      'Writes a setup sample INTO storage while a source is being configured. Inbound only.',
  },
  {
    path: 'functions/api/sources/[id]/drop.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 1, readers: 0, checks: 0 },
    reason:
      'Writes a file dropped on a source INTO storage for a run. Inbound only.',
  },
  {
    path: 'functions/api/sources/[id]/run.ts',
    classification: 'not_exit',
    signature: { bucket: 1, gets: 1, readers: 0, checks: 0 },
    reason:
      'Writes a file uploaded for a source run INTO storage. Inbound only.',
  },
  {
    path: 'functions/api/sources/[id]/sample.ts',
    classification: 'not_exit',
    signature: { bucket: 3, gets: 1, readers: 0, checks: 0 },
    reason:
      'The sample file an admin uploaded while setting up a source. A setup artefact, never an approved document.',
  },
  {
    path: 'functions/api/sources/[id]/test.ts',
    classification: 'not_exit',
    signature: { bucket: 3, gets: 1, readers: 0, checks: 0 },
    reason:
      'Reads a source\'s setup sample to run a test extraction over it. The bytes are parsed, not returned.',
  },
  {
    path: 'functions/api/sources/preview-extraction.ts',
    classification: 'not_exit',
    signature: { bucket: 3, gets: 1, readers: 0, checks: 0 },
    reason:
      'Reads a setup sample by its sample id to preview what extraction would read. The bytes are parsed, not returned.',
  },
  {
    path: 'functions/api/sources/[id]/runs/[runId]/retry.ts',
    classification: 'not_exit',
    signature: { bucket: 2, gets: 1, readers: 0, checks: 0 },
    reason:
      'Re-reads the file a source run ingested so the run can be dispatched again. Intake input, not an approved document, and nothing is returned.',
  },
  // ---- the tenant brand logo (migration 0140) ----------------------------
  // A NEW PUBLIC, UNAUTHENTICATED READ OF THE BUCKET, registered on purpose.
  // It is not an exit because no document can be reached through it: the only
  // key ever read is rebuilt as brand/<tenant>/logo-<sha256>.<ext> from a row
  // of tenant_brand_logos, and must equal the key that row stores.
  {
    path: 'functions/lib/tenant-brand.ts',
    classification: 'not_exit',
    signature: { bucket: 6, gets: 2, readers: 0, checks: 0 },
    reason:
      'Writes and reads an organisation logo. readBrandLogo takes a 40-hex token, finds a tenant_brand_logos row by it, REBUILDS the key from that row (brand/<tenant>/logo-<sha256>.<ext>) and refuses unless it equals the stored key, so no caller-supplied string reaches the bucket and no document key can be formed. The second .get( is the per-request brand cache, a Map.',
  },
  {
    path: 'functions/api/public/brand-logo/[token].ts',
    classification: 'not_exit',
    signature: { bucket: 2, gets: 0, readers: 0, checks: 0 },
    reason:
      'The public logo route: unauthenticated by design, because a logo is drawn in mail and on token pages. It hands the bucket to readBrandLogo and returns only what that returns -- an image a tenant admin published as their logo, never an approved document. The sharing rule does not apply to a logo.',
  },
  {
    path: 'functions/api/tenants/[id]/brand/logo.ts',
    classification: 'not_exit',
    signature: { bucket: 2, gets: 1, readers: 0, checks: 0 },
    reason:
      'An admin uploads or removes the organisation logo. It writes INTO the bucket (through storeBrandLogo) and returns the brand record as JSON, never file bytes. The .get( is FormData.get on the upload.',
  },
];
