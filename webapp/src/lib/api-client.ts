'use client';

import pb from './pocketbase';

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Call the webapp's own /next-api/* route handlers. Adds the PocketBase auth token
 * as a bearer header so the server can verify the caller.
 */
export async function api<T = unknown>(
  path: string,
  options: ApiOptions = {}
): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (pb.authStore.token) {
    headers.Authorization = `Bearer ${pb.authStore.token}`;
  }

  const res = await fetch(url.toString(), {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }

  return parsed as T;
}
