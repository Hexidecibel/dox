/**
 * Build a consistent R2 key for a document version.
 * Format: {tenantSlug}/{docId}/{version}/{fileName}
 */
export function buildR2Key(
  tenantSlug: string,
  docId: string,
  version: number,
  fileName: string
): string {
  return `${tenantSlug}/${docId}/${version}/${fileName}`;
}

/**
 * Upload a file to R2.
 */
export async function uploadFile(
  bucket: R2Bucket,
  key: string,
  file: ArrayBuffer | ReadableStream,
  contentType: string
): Promise<R2Object> {
  return bucket.put(key, file, {
    httpMetadata: { contentType },
  });
}

/**
 * Download a file from R2.
 */
export async function downloadFile(
  bucket: R2Bucket,
  key: string
): Promise<R2ObjectBody | null> {
  return bucket.get(key);
}

/**
 * Delete a file from R2.
 */
export async function deleteFile(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key);
}

/**
 * Compute SHA-256 checksum of file data, returned as hex.
 */
export async function computeChecksum(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
