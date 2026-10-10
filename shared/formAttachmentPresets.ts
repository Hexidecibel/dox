/**
 * The file-type presets the Records form builder offers for a public form's
 * uploads ("Images", "PDF", "Office docs").
 *
 * Here, and not in the builder, so that the upload route's test can read the
 * same list: `tests/api/records-public-adversarial.test.ts` uploads a file of
 * EVERY type every preset names and expects it to be accepted. The first
 * version of the upload's type check (C-140) refused the Office preset's own
 * types, and nothing noticed because the list and the check lived apart.
 * Adding a type here without a sample file in that test fails the test.
 *
 * Pure: no React, no MUI.
 */

export interface FormAttachmentPreset {
  key: string;
  label: string;
  /** MIME types; `image/*` style wildcards allowed. */
  types: string[];
}

export const FORM_ATTACHMENT_PRESETS: FormAttachmentPreset[] = [
  { key: 'images', label: 'Images', types: ['image/*'] },
  { key: 'pdf', label: 'PDF', types: ['application/pdf'] },
  {
    key: 'office',
    label: 'Office docs',
    types: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/msword',
      'application/vnd.ms-excel',
    ],
  },
];
