import 'server-only';
import { z } from 'zod';
import {
  classifyFetchFailure,
  GarageAuthError,
  GarageConfigError,
  GarageError,
  GarageNotEmptyError,
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

  /**
   * Which of the two required env vars are missing. Exported separately from
   * `fromEnv` so a status page can report "not configured" without provoking a
   * throw it would only have to catch.
   */
  static missingEnv(): string[] {
    // Trimmed: a var set to whitespace is not configured, and reporting it as
    // present sends the operator chasing a rejected-token error instead.
    const missing: string[] = [];
    if (!process.env.GARAGE_ADMIN_URL?.trim()) missing.push('GARAGE_ADMIN_URL');
    if (!process.env.GARAGE_ADMIN_TOKEN?.trim())
      missing.push('GARAGE_ADMIN_TOKEN');
    return missing;
  }

  static fromEnv(): GarageClient {
    const missing = GarageClient.missingEnv();
    if (missing.length > 0) {
      // A typed error, not a bare one: `errorResponse` maps this to a 503 with
      // a message meant for a human, instead of leaking the internal sentence
      // this used to throw straight into the browser's error banner.
      throw new GarageConfigError(missing);
    }
    return new GarageClient({
      baseUrl: (process.env.GARAGE_ADMIN_URL as string).trim(),
      token: (process.env.GARAGE_ADMIN_TOKEN as string).trim(),
    });
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
      // undici reports every transport failure as `TypeError: fetch failed`
      // and puts the real reason on `err.cause`. Classify it here and keep the
      // cause attached, so callers can tell a refused port from a bad hostname
      // from a timeout rather than all three reading "fetch failed".
      const { code, message } = classifyFetchFailure(err);
      throw new GarageError(message, {
        status: 0,
        endpoint,
        code,
        cause: err,
      });
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
    // The one precondition Garage documents on a delete. It is only ever a 400
    // from DeleteBucket, so the endpoint is part of the match — a 400 from
    // anywhere else means something different and must stay generic.
    if (status === 400 && endpoint === '/v2/DeleteBucket') {
      throw new GarageNotEmptyError(endpoint, body);
    }
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? String((body as { message: unknown }).message)
        : `Garage request failed (${status})`;
    throw new GarageError(message, { status, endpoint, body });
  }
}
