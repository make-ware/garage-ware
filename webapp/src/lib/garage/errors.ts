import 'server-only';

export class GarageError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly body: unknown;

  constructor(
    message: string,
    opts: { status: number; endpoint: string; body?: unknown }
  ) {
    super(message);
    this.name = 'GarageError';
    this.status = opts.status;
    this.endpoint = opts.endpoint;
    this.body = opts.body;
  }
}

export class GarageNotFoundError extends GarageError {
  constructor(endpoint: string, body?: unknown) {
    super('Garage resource not found', { status: 404, endpoint, body });
    this.name = 'GarageNotFoundError';
  }
}

export class GarageQuorumError extends GarageError {
  constructor(endpoint: string, body?: unknown) {
    super('Garage cluster lost quorum', { status: 503, endpoint, body });
    this.name = 'GarageQuorumError';
  }
}

export class GarageAuthError extends GarageError {
  constructor(endpoint: string, body?: unknown) {
    super('Garage rejected admin token', { status: 401, endpoint, body });
    this.name = 'GarageAuthError';
  }
}

export class GarageValidationError extends GarageError {
  constructor(endpoint: string, body?: unknown) {
    super('Garage response did not match expected schema', {
      status: 0,
      endpoint,
      body,
    });
    this.name = 'GarageValidationError';
  }
}
