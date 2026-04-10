// Type declarations for cloudflare:test module.
// Cloudflare.Env maps to our app's Env interface from functions/lib/types.ts.

interface CloudflareEnv {
  DB: D1Database;
  FILES: R2Bucket;
  JWT_SECRET: string;
  RESEND_API_KEY?: string;
  EMAIL_WEBHOOK_SECRET?: string;
  QWEN_URL?: string;
  QWEN_SECRET?: string;
  CONNECTOR_ENCRYPTION_KEY?: string;
}

declare namespace Cloudflare {
  interface Env extends CloudflareEnv {}
}
