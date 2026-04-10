/**
 * HTTP request helper for API tests running in the Workers pool.
 * Uses SELF from cloudflare:test to make requests to the worker under test.
 */

import { SELF } from 'cloudflare:test';

export interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

/**
 * Make an API request to the worker under test.
 * Paths are relative to /api (e.g. '/auth/login' -> 'http://localhost/api/auth/login').
 */
export async function apiRequest(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }
  if (options.apiKey) {
    headers['X-API-Key'] = options.apiKey;
  }

  const url = `http://localhost/api${path}`;

  return SELF.fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

/**
 * Convenience: make a GET request and parse JSON response.
 */
export async function apiGet<T = unknown>(path: string, token?: string): Promise<{ status: number; data: T }> {
  const res = await apiRequest(path, { token });
  const data = await res.json() as T;
  return { status: res.status, data };
}

/**
 * Convenience: make a POST request and parse JSON response.
 */
export async function apiPost<T = unknown>(
  path: string,
  body: unknown,
  token?: string
): Promise<{ status: number; data: T }> {
  const res = await apiRequest(path, { method: 'POST', body, token });
  const data = await res.json() as T;
  return { status: res.status, data };
}
