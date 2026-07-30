import 'server-only';
import { z } from 'zod';
import {
  GarageAuthError,
  GarageError,
  GarageNotFoundError,
  GarageQuorumError,
  GarageValidationError,
} from './errors';

export interface GarageClientConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

export class GarageClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: GarageClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  static fromEnv(): GarageClient {
    const baseUrl = process.env.GARAGE_ADMIN_URL;
    const token = process.env.GARAGE_ADMIN_TOKEN;
    if (!baseUrl || !token) {
      throw new Error(
        'GARAGE_ADMIN_URL and GARAGE_ADMIN_TOKEN must be set to use GarageClient'
      );
    }
    return new GarageClient({ baseUrl, token });
  }

  async request<T>(
    endpoint: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = this.buildUrl(endpoint, options.query);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch (err) {
      clearTimeout(timeout);
      throw new GarageError(
        err instanceof Error ? err.message : 'Garage request failed',
        { status: 0, endpoint }
      );
    }
    clearTimeout(timeout);

    const text = await response.text();
    let parsedBody: unknown = undefined;
    if (text.length > 0) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = text;
      }
    }

    if (!response.ok) {
      this.throwForStatus(response.status, endpoint, parsedBody);
    }

    const result = schema.safeParse(parsedBody);
    if (!result.success) {
      throw new GarageValidationError(endpoint, {
        zodIssues: result.error.issues,
        body: parsedBody,
      });
    }
    return result.data;
  }

  private buildUrl(
    endpoint: string,
    query?: Record<string, string | number | boolean | undefined>
  ): string {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = new URL(`${this.baseUrl}${cleanEndpoint}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private throwForStatus(
    status: number,
    endpoint: string,
    body: unknown
  ): never {
    if (status === 401 || status === 403) {
      throw new GarageAuthError(endpoint, body);
    }
    if (status === 404) {
      throw new GarageNotFoundError(endpoint, body);
    }
    if (status === 503) {
      throw new GarageQuorumError(endpoint, body);
    }
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? String((body as { message: unknown }).message)
        : `Garage request failed (${status})`;
    throw new GarageError(message, { status, endpoint, body });
  }
}
