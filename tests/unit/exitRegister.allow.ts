/**
 * THE EXIT REGISTER -- every file under functions/ that reads a file's bytes
 * out of storage, and whether that read is a way a document LEAVES.
 *
 * tests/unit/exitRegister.test.ts scans functions/ for R2 body reads and fails
 * when it finds one in a file that is not listed here. So a new way out of the
 * portal cannot be added quietly: whoever adds it has to come here and say
 * which of the two it is.
 *
 *   exit      The bytes of an approved DOCUMENT can reach a person or a system
 *             through this file. It must ask the sharing rule (decision C-003,
 *             migration 0137), and `checked_by` names the function it asks
 *             through -- the test checks that name is still in the file.
 *
 *   not_exit  The read is something else: the file is not an approved document
 *             (a queue item, an arrival, a connector's sample), or the bytes
 *             go back into storage rather than out to anybody. Say which.
 *
 * Every entry carries a one-line reason. An entry whose file no longer reads
 * storage fails the test too: a stale line here is a door somebody will walk
 * the next read through.
 */

export type ExitClassification = 'exit' | 'not_exit';

export interface ExitRegisterEntry {
  /** Repo-relative path, exact. */
  path: string;
  classification: ExitClassification;
  /** Why it is classified that way. */
  reason: string;
  /**
   * `exit` only: the sharing-rule function this file asks through. Must appear
   * in the file outside comments.
   */
  checked_by?: string;
}

/** The functions that ask the sharing rule. An `exit` must name one of these. */
export const SHARING_RULE_CHECKS = [
  'apiKeyFileRefusal',
  'judgeDocumentsForExit',
  'judgeSharedFile',
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
    reason:
      'One document file, and the packet original it was split from. A logged-in person is not asked; an API key reads "send freely" only (the packet: strictest rule of every document citing it).',
  },
  {
    path: 'functions/api/queue/[id]/file.ts',
    classification: 'exit',
    checked_by: 'apiKeyFileRefusal',
    reason:
      'Serves the queue item\'s own staging file (not a document) and, once approved, FALLS BACK to the approved document\'s bytes. The fallback is the exit: an API key reads it only when every document from that item is "send freely".',
  },
  {
    path: 'functions/api/request-uploads/[id]/file.ts',
    classification: 'exit',
    checked_by: 'apiKeyFileRefusal',
    reason:
      'Serves a supplier arrival (not a document) and, once approved, FALLS BACK to the linked document\'s current version. The fallback is the exit, checked for an API key.',
  },
  {
    path: 'functions/api/bundles/[id]/download.ts',
    classification: 'exit',
    checked_by: 'judgeDocumentsForExit',
    reason: 'The bundle ZIP. Every item is judged for the `bundle` exit; what is kept back is named in the archive, the headers and the audit row.',
  },
  {
    path: 'functions/api/document-exports/zip.ts',
    classification: 'exit',
    checked_by: 'loadExportDocuments',
    reason: 'The search export ZIP. Its rows come only from loadExportDocuments, which judges the `zip` exit.',
  },
  {
    path: 'functions/api/document-exports/public/[token]/download.ts',
    classification: 'exit',
    checked_by: 'loadExportLinkSet',
    reason: 'A recipient\'s ZIP from an emailed link. The rule is re-read on every request (`public_link`): a document locked since the send is left out.',
  },
  {
    path: 'functions/api/document-exports/public/[token]/file/[index].ts',
    classification: 'exit',
    checked_by: 'loadExportLinkDocuments',
    reason: 'One file from an emailed link, addressed by position in the list the rule has already filtered (`public_link`).',
  },
  {
    path: 'functions/lib/document-export.ts',
    classification: 'exit',
    checked_by: 'judgeDocumentsForExit',
    reason:
      'Defines readExportBytes and buildExportZip. The rows they read are produced by loadExportDocuments in the same file, which will not return a row without an exit and an actor.',
  },
  {
    path: 'functions/lib/order-send.ts',
    classification: 'exit',
    checked_by: 'judgeSharedFile',
    reason:
      'An order\'s attachments, first send and resend. The plan judges each line (`order_send`), and runParts judges every stored file again immediately before its bytes are read.',
  },

  // ---- not exits ---------------------------------------------------------
  {
    path: 'functions/lib/r2.ts',
    classification: 'not_exit',
    reason: 'Defines downloadFile. It reads a key it is handed; every caller is on this list in its own right.',
  },
  {
    path: 'functions/lib/kinds/coa.ts',
    classification: 'not_exit',
    reason: 'The approve path: reads the pending queue file to write it back to storage under a document version key. Nothing is returned to the caller.',
  },
  {
    path: 'functions/lib/packet-split.ts',
    classification: 'not_exit',
    reason: 'Reads a packet in the Review Queue to cut it into parts, which are written back to storage as new queue items. Not an approved document, and nothing leaves.',
  },
  {
    path: 'functions/api/request-uploads/[id]/enqueue.ts',
    classification: 'not_exit',
    reason: 'Reads a supplier arrival to hand it to the Review Queue. An arrival is not a document, and the bytes go into the queue, not to the caller.',
  },
  {
    path: 'functions/api/records/attachments/[attachmentId]/download.ts',
    classification: 'not_exit',
    reason: 'A Records attachment is a file on a sheet row, not a registry document: it has no document type and so no sharing rule to ask. Tenant-gated.',
  },
  {
    path: 'functions/api/sources/[id]/sample.ts',
    classification: 'not_exit',
    reason: 'The sample file an admin uploaded while setting up a source. A setup artefact, never an approved document.',
  },
  {
    path: 'functions/api/sources/[id]/test.ts',
    classification: 'not_exit',
    reason: 'Reads a source\'s setup sample to run a test extraction over it. The bytes are parsed, not returned.',
  },
  {
    path: 'functions/api/sources/preview-extraction.ts',
    classification: 'not_exit',
    reason: 'Reads a setup sample by its sample id to preview what extraction would read. The bytes are parsed, not returned.',
  },
  {
    path: 'functions/api/sources/[id]/runs/[runId]/retry.ts',
    classification: 'not_exit',
    reason: 'Re-reads the file a source run ingested so the run can be dispatched again. Intake input, not an approved document, and nothing is returned.',
  },
];
