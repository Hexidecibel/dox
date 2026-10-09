/**
 * The inputs the pre-0140 golden was rendered from (tests/fixtures/brand-mail/
 * pre-0140-golden.json). Invented values only. Every string an outsider mail
 * prints is here once, so the fallback test and the branded test render the
 * same message and differ only in the brand.
 */
import {
  buildApprovalRequestEmail,
  buildDocumentExportEmail,
  buildUpdateRequestEmail,
} from '../../functions/lib/email';
import { buildOrderDocumentsEmail } from '../../functions/lib/order-send';
import { buildRenewalRequestSupplierEmail } from '../../functions/lib/renewal-request-email';

export const SAMPLE_TENANT = 'Northfield Provisions';

export const exportParams = {
  tenantName: SAMPLE_TENANT,
  senderName: 'Dana Whitlow',
  senderEmail: 'dana@northfield.example',
  onBehalfOf: 'Sam in Sales',
  message: 'Here are the three you asked for.\nCall me if one is missing.',
  documents: [
    { title: 'COA Lot 24117', supplier_name: 'Harbor Mills', document_type_name: 'COA', lot_label: '24117' },
    { title: 'Allergen Statement', supplier_name: null, document_type_name: null, lot_label: null },
  ],
  linkUrl: 'https://portal.example/export/tok_abc',
  expiresAt: '2026-11-01T00:00:00Z',
};

export const orderParams = {
  tenantName: SAMPLE_TENANT,
  senderName: 'Dana Whitlow',
  senderEmail: 'dana@northfield.example',
  orderNumber: 'SO-55012',
  poNumber: 'PO-7781',
  shipDate: '2026-10-12',
  message: "Certificates for Monday's truck.",
  partNumber: 1,
  partCount: 2,
  attached: [{ file_name: 'SO-55012_COA_24117.pdf', document_title: 'COA Lot 24117', lot_label: '24117' }],
  linked: [{ file_name: 'SO-55012_COA_24118.pdf', document_title: 'COA Lot 24118', lot_label: '24118' }],
  linkUrl: 'https://portal.example/export/tok_big',
  documents: [{ file_name: 'SO-55012_Spec.pdf', document_title: 'Spec Sheet', lot_label: null }],
  documentsLinkUrl: 'https://portal.example/export/tok_docs',
  documentsLinkDays: 30,
};

export const orderPlainParams = {
  tenantName: SAMPLE_TENANT,
  senderName: 'Dana Whitlow',
  senderEmail: 'dana@northfield.example',
  orderNumber: 'SO-55013',
  poNumber: null,
  shipDate: null,
  message: null,
  partNumber: 1,
  partCount: 1,
  attached: [{ file_name: 'SO-55013_COA.pdf', document_title: null, lot_label: null }],
  linked: [],
  linkUrl: null,
};

export const renewalParams = {
  tenantName: SAMPLE_TENANT,
  body: 'Hello Pat,\n\nYour kosher certificate runs out on 1 November 2026.\nPlease send the new one.\n\nDana Whitlow\n',
  linkUrl: 'https://portal.example/r/tok_req',
};

export const updateRequestParams = {
  recipientName: 'Pat',
  senderName: 'Dana Whitlow',
  senderEmail: 'dana@northfield.example',
  sheetName: 'Supplier contacts',
  rowTitle: 'Harbor Mills',
  message: 'Two minutes, promise.',
  dueDate: '2026-10-20',
  fieldCount: 3,
  publicUrl: 'https://portal.example/u/tok_upd',
};

export const approvalParams = {
  recipientName: null,
  senderName: 'Dana Whitlow',
  senderEmail: 'dana@northfield.example',
  workflowName: 'New supplier',
  stepName: 'QA sign-off',
  message: null,
  sheetName: 'Supplier onboarding',
  rowTitle: 'Harbor Mills',
  publicUrl: 'https://portal.example/a/tok_apr',
};

/** Render every outsider mail with whatever extra (a brand) the caller adds. */
export function renderOutsideMails(extra: Record<string, unknown> = {}): Record<string, string> {
  const e = extra as never as Record<string, never>;
  const exp = buildDocumentExportEmail({ ...exportParams, ...e });
  const upd = buildUpdateRequestEmail({ ...updateRequestParams, ...e });
  const apr = buildApprovalRequestEmail({ ...approvalParams, ...e });
  return {
    export_html: exp.html,
    export_text: exp.text,
    export_subject: exp.subject,
    order_html: buildOrderDocumentsEmail({ ...orderParams, ...e }).html,
    order_plain_html: buildOrderDocumentsEmail({ ...orderPlainParams, ...e }).html,
    renewal_html: buildRenewalRequestSupplierEmail({ ...renewalParams, ...e }).html,
    update_request_html: upd.html,
    update_request_subject: upd.subject,
    approval_html: apr.html,
    approval_subject: apr.subject,
  };
}
