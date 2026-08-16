import 'server-only';

/**
 * How a Garage call failed, in a form the UI can act on.
 *
 * `GarageError.status` is the HTTP status Garage answered with, and is `0` for
 * everything that never got an answer — a refused connection, a DNS miss, a TLS
 * failure, a timeout, and a response that did not match our schema all shared
 * that one value. `code` is what tells those apart, so a status page can say
 * "nothing is listening on that port" instead of "fetch failed".
 */
export type GarageFailureCode =
  | 'not_configured'
  | 'unreachable'
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'auth'
  | 'not_found'
  | 'quorum'
  | 'schema'
  | 'http';

export class GarageError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly body: unknown;
  readonly code: GarageFailureCode;

  constructor(
    message: string,
    opts: {
      status: number;
      endpoint: string;
      body?: unknown;
      code?: GarageFailureCode;
      cause?: unknown;
    }
  ) {
    super(
      message,
      opts.cause !== undefined ? { cause: opts.cause } : undefined
    );
    this.name = 'GarageError';
    this.status = opts.status;
    this.endpoint = opts.endpoint;
    this.body = opts.body;
    this.code = opts.code ?? 'http';
  }
}

/**
 * The env vars naming the cluster are unset.
 *
 * Its own class because it is the one Garage failure that is not a failure of
 * Garage — nothing was attempted. Before this existed `fromEnv()` threw a bare
 * `Error`, which `errorResponse` could only render as a 500 carrying the
 * internal string "GARAGE_ADMIN_URL and GARAGE_ADMIN_TOKEN must be set to use
 * GarageClient" straight into the browser.
 */
export class GarageConfigError extends GarageError {
  /** Which of the two vars are missing, for a status page to name them. */
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`Garage is not configured: ${missing.join(', ')} not set`, {
      status: 0,
      endpoint: '(config)',
      code: 'not_configured',
    });
    this.name = 'GarageConfigError';
    this.missing = missing;
  }
}

export class GarageNotFoundError extends GarageError {
  constructor(endpoint: string, body?: unknown) {
    super('Garage resource not found', {
      status: 404,
      endpoint,
      body,
      code: 'not_found',
    });
    this.name = 'GarageNotFoundError';
  }
}

export class GarageQuorumError extends GarageError {
  constructor(endpoint: string, body?: unknown) {
    super('Garage cluster lost quorum', {
      status: 503,
      endpoint,
      body,
      code: 'quorum',
    });
    this.name = 'GarageQuorumError';
  }
}

export class GarageAuthError extends GarageError {
  constructor(endpoint: string, body?: unknown) {
    super('Garage rejected admin token', {
      status: 401,
      endpoint,
      body,
      code: 'auth',
    });
    this.name = 'GarageAuthError';
  }
}

export class GarageValidationError extends GarageError {
  constructor(endpoint: string, body?: unknown) {
    super('Garage response did not match expected schema', {
      status: 0,
      endpoint,
      body,
      code: 'schema',
    });
    this.name = 'GarageValidationError';
  }
}

/**
 * Classify a thrown `fetch` rejection.
 *
 * undici collapses every transport failure into `TypeError: fetch failed` and
 * hangs the real reason off `err.cause` — which the client used to discard, so
 * a wrong port and a wrong hostname were indistinguishable downstream. Walk the
 * cause chain for the syscall code; an `AbortError` on the outer error is our
 * own 15s timeout firing.
 */
export function classifyFetchFailure(err: unknown): {
  code: GarageFailureCode;
  message: string;
} {
  if (err instanceof Error && err.name === 'AbortError') {
    return { code: 'timeout', message: 'Garage did not respond in time' };
  }

  let cause: unknown = err;
  const seen = new Set<unknown>();
  while (cause && typeof cause === 'object' && !seen.has(cause)) {
    seen.add(cause);
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') {
      switch (code) {
        case 'ECONNREFUSED':
          return {
            code: 'unreachable',
            message: 'Connection refused by the Garage admin API',
          };
        case 'ECONNRESET':
        case 'EPIPE':
          return {
            code: 'unreachable',
            message: 'Connection to the Garage admin API was reset',
          };
        case 'EHOSTUNREACH':
        case 'ENETUNREACH':
          return {
            code: 'unreachable',
            message: 'No network route to the Garage admin API',
          };
        case 'ETIMEDOUT':
        case 'UND_ERR_CONNECT_TIMEOUT':
        case 'UND_ERR_HEADERS_TIMEOUT':
          return { code: 'timeout', message: 'Garage did not respond in time' };
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
          return {
            code: 'dns',
            message: 'Could not resolve the Garage admin API hostname',
          };
        default:
          if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL')) {
            return {
              code: 'tls',
              message: 'TLS handshake with the Garage admin API failed',
            };
          }
          if (
            code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
            code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
            code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
            code === 'CERT_HAS_EXPIRED'
          ) {
            return {
              code: 'tls',
              message: `Garage admin API TLS certificate rejected (${code})`,
            };
          }
      }
    }
    cause = (cause as { cause?: unknown }).cause;
  }

  return {
    code: 'unreachable',
    message: 'Could not reach the Garage admin API',
  };
}
