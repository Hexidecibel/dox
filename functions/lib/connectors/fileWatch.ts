/**
 * File-watch connector executor.
 *
 * Handles inputs of type `file_watch`:
 *   - Manual run path: content buffer carried inline on the input
 *   - Future bucket-watch path: r2Key pulled from R2
 *
 * The executor routes by file extension / content-type to the right
 * attachment parser from email.ts. We treat the uploaded file as an
 * attachment-style payload and reuse the battle-tested CSV / XLSX / PDF
 * paths from the email connector — that way field-mapping behavior stays
 * identical no matter which connector type brought the file in.
 */

import type {
  ConnectorExecuteFn,
  ConnectorOutput,
  ConnectorInput,
  ConnectorContext,
  EmailAttachment,
} from './types';
import { execute as executeEmailConnector, parseCSVAttachment } from './email';
import { normalizeFieldMappings } from '../../../shared/fieldMappings';

function inferContentType(fileName: string, explicit?: string): string {
  if (explicit) return explicit;
  const lower = (fileName || '').toLowerCase();
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.tsv')) return 'text/tsv';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

function isCsvLike(contentType: string, fileName: string): boolean {
  const ct = (contentType || '').toLowerCase();
  const name = (fileName || '').toLowerCase();
  return (
    ct === 'text/csv' ||
    ct === 'text/tsv' ||
    ct === 'text/plain' ||
    name.endsWith('.csv') ||
    name.endsWith('.tsv') ||
    name.endsWith('.txt')
  );
}

function isXlsxLike(contentType: string, fileName: string): boolean {
  const ct = (contentType || '').toLowerCase();
  const name = (fileName || '').toLowerCase();
  return (
    ct === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    ct === 'application/vnd.ms-excel' ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls')
  );
}

function isPdfLike(contentType: string, fileName: string): boolean {
  const ct = (contentType || '').toLowerCase();
  const name = (fileName || '').toLowerCase();
  return ct === 'application/pdf' || name.endsWith('.pdf');
}

export const execute: ConnectorExecuteFn = async (
  ctxIn: ConnectorContext,
  input: ConnectorInput,
): Promise<ConnectorOutput> => {
  if (input.type !== 'file_watch') {
    return {
      orders: [],
      customers: [],
      errors: [{ message: 'Expected file_watch input' }],
    };
  }

  // Normalize field_mappings defensively (matches the email executor).
  const ctx: ConnectorContext = {
    ...ctxIn,
    fieldMappings: normalizeFieldMappings(ctxIn.fieldMappings),
  };

  // Resolve the file bytes: either inline (content) or pulled from R2.
  let buffer: ArrayBuffer;
  if (input.content) {
    buffer = input.content;
  } else if (input.r2Key && ctx.r2) {
    const object = await ctx.r2.get(input.r2Key);
    if (!object) {
      return {
        orders: [],
        customers: [],
        errors: [{ message: `File not found in R2: ${input.r2Key}` }],
      };
    }
    buffer = await object.arrayBuffer();
  } else {
    return {
      orders: [],
      customers: [],
      errors: [{ message: 'file_watch input has neither content nor a reachable r2Key' }],
    };
  }

  const contentType = inferContentType(input.fileName, input.contentType);
  const attachment: EmailAttachment = {
    filename: input.fileName,
    content: buffer,
    contentType,
    size: buffer.byteLength,
  };

  // Dispatch by type. CSV / TSV / TXT go through parseCSVAttachment
  // directly (no AI needed). XLSX and PDF piggy-back on the email
  // connector's attachment parsers so behavior stays consistent.
  if (isCsvLike(contentType, input.fileName)) {
    return parseCSVAttachment(ctx, attachment);
  }

  if (isXlsxLike(contentType, input.fileName) || isPdfLike(contentType, input.fileName)) {
    return executeEmailConnector(ctx, {
      type: 'email',
      body: '',
      subject: `file-watch :: ${input.fileName}`,
      sender: 'file-watch@dox.local',
      attachments: [attachment],
    });
  }

  return {
    orders: [],
    customers: [],
    errors: [
      {
        message: `Unsupported file type for file_watch: ${input.fileName} (content-type: ${contentType})`,
      },
    ],
  };
};
