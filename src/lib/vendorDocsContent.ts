/**
 * vendorDocsContent — typed copy library for the public vendor-facing
 * docs at /docs/connectors.
 *
 * Phase D5 carved this out of `helpContent` because the vendor-facing
 * page is long-form, structured (intro / example / gotchas per door),
 * and rendered outside the protected app shell. helpContent stays the
 * source of truth for *admin-facing* in-app copy; this file is the
 * source of truth for *vendor-facing* public copy.
 *
 * Conventions (match helpContent):
 *   - Plain ASCII (no smart quotes), keeps grep + diff sane.
 *   - Placeholders are written `<like-this>` so vendors know exactly
 *     what to swap. NEVER hard-code real slugs, tokens, account ids,
 *     access keys, or secrets here — the page is shipped to the public.
 *   - Section ids match anchor hashes used by the in-page TOC.
 */
export interface VendorDoorSection {
  /** Stable anchor id used in the TOC. */
  id: string;
  /** Section title in the page. */
  title: string;
  /** One-paragraph "what this is, when to use it" lead-in. */
  intro: string;
  /** Optional second paragraph for context where the door is unusual. */
  detail?: string;
  /** Copy-paste-ready example block. Rendered as a monospace pre. */
  example: string;
  /** Optional secondary example (e.g. AWS credentials snippet). */
  secondaryExampleTitle?: string;
  secondaryExample?: string;
  /** Common gotchas surfaced as a bullet list. */
  gotchas: ReadonlyArray<string>;
}

export interface VendorDocsContent {
  pageTitle: string;
  intro: string;
  doors: ReadonlyArray<VendorDoorSection>;
  footer: string;
}

export const vendorDocsContent: VendorDocsContent = {
  pageTitle: 'Sending files to a dox connector',
  intro:
    "A dox connector is the inbound channel for files going to a tenant. Whoever shared this page with you set one up and picked a slug for it (the URL-safe handle baked into every delivery address). You can deliver files through any of the doors below — pick whichever fits your tooling. All five doors land the file in the same place; the tenant on the other side will see your upload regardless of how it arrived.",
  doors: [
    {
      id: 'email',
      title: 'Email',
      intro:
        "Send the file as an attachment to the per-connector inbox. Best if you already email reports as PDFs / CSVs / XLSX and just want them to land in dox automatically.",
      example:
        'To: <connector-slug>@supdox.com\n' +
        'From: <your address>\n' +
        'Subject: <anything — for your records>\n' +
        'Attachments: orders.csv, weekly-report.xlsx',
      gotchas: [
        "Plain-text emails without attachments are ignored. Only the attached files are processed.",
        "Maximum file size per attachment: 10 MB. Larger files should use the API or S3 door.",
        "Subject lines are kept for your reference but are not used for routing — every email to <slug>@supdox.com hits the same connector.",
        "If the connector owner has set sender or subject filters, only matching emails will be processed. Ask them which filters are in place if your test emails get dropped silently.",
      ],
    },
    {
      id: 'api',
      title: 'HTTP API',
      intro:
        "POST a multipart file body to the connector's drop endpoint with a bearer token. Best if you already have an automation script (curl, Python requests, Node fetch, etc.) emitting files on a schedule.",
      example:
        'curl -X POST \\\n' +
        '  -H "Authorization: Bearer <your-bearer-token>" \\\n' +
        '  -F "file=@/path/to/orders.csv" \\\n' +
        '  https://supdox.com/api/connectors/<connector-slug>/drop',
      gotchas: [
        "If you start getting 401 Unauthorized, the connector owner rotated the token. Ask them for the new one — the old token is dead the moment they rotate.",
        "The `file` field name is required. The endpoint reads the first form-data file under that exact key.",
        "On success the endpoint returns 202 Accepted with a JSON body containing the run id. Use that id to correlate with the connector owner if anything goes wrong.",
        "Rate limits are generous but not unlimited — if you have thousands of files to send, batch them with a small delay between requests rather than firing them all at once.",
      ],
    },
    {
      id: 's3',
      title: 'S3 bucket',
      intro:
        "Upload to a per-connector S3-compatible bucket using vendor-specific credentials. Best if you already use AWS / S3 tooling (aws-cli, rclone, boto3) and want to drop files without writing new HTTP code.",
      detail:
        "The bucket is hosted on Cloudflare R2, which speaks the S3 protocol. Any tool that lets you point at a custom endpoint URL will work — just plug in the values the connector owner gave you.",
      example:
        'aws s3 cp /path/to/orders.csv \\\n' +
        '  s3://dox-drops-<connector-slug>/ \\\n' +
        '  --endpoint-url https://<account-id>.r2.cloudflarestorage.com \\\n' +
        '  --profile dox-<connector-slug>',
      secondaryExampleTitle: '~/.aws/credentials',
      secondaryExample:
        '[dox-<connector-slug>]\n' +
        'aws_access_key_id = <your-access-key-id>\n' +
        'aws_secret_access_key = <your-secret-key>',
      gotchas: [
        "Ingestion is on a 5-minute poll cadence. Your file lands in dox between 0 and 5 minutes after the upload completes — it is not instant.",
        "The secret key is shown only once when the connector owner provisions or rotates it. If you lost it, you need a new pair — the old secret is not recoverable.",
        "Use the `--endpoint-url` flag (or the equivalent in your S3 client) to point at the R2 hostname. Without it, your client will hit AWS S3 and get a 403.",
        "Files are dedup'd by key — uploading the same key twice will only ingest once. Use unique filenames (e.g. include a timestamp) if you need to send the same content multiple times.",
      ],
    },
    {
      id: 'public-link',
      title: 'Public link',
      intro:
        "A no-login web upload form at a tenant-shared URL. Best if you have nothing more than a browser and a file on your desktop — drag the file onto the page and you're done.",
      example: 'https://supdox.com/drop/<connector-slug>/<link-token>',
      gotchas: [
        "The URL is the credential. Treat it like a password — anyone who has the URL can upload to this connector. Don't post it in public chats or commit it to a repo.",
        "Links expire (default 30 days). If you see 'This link is no longer active,' the link was revoked or expired — ask the connector owner for a new one.",
        "Only one file per drop. The form does not currently accept multi-file uploads; submit each file separately.",
        "You don't get a receipt by email. The page confirms 'File received' on success — that confirmation is your only signal that it worked.",
      ],
    },
    {
      id: 'manual-upload',
      title: 'Manual upload (admin UI)',
      intro:
        "If you have access to the dox admin UI for the tenant on the other side, open the connector's detail page and drop a file directly into the upload zone. Most vendors won't have admin access — this door is mainly for the tenant's own staff testing the connector.",
      example: '(Sign in to dox, navigate to the connector, drag a file onto the upload zone.)',
      gotchas: [
        "Requires a dox login with at least `user` role on the tenant. If you can't sign in, use one of the four doors above instead.",
      ],
    },
  ],
  footer:
    'Need help? Contact the person at the tenant who shared this page with you — they own the connector and can rotate credentials, extend a public link, or check why a delivery did not land.',
};
