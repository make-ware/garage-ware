import { describe, expect, it } from 'vitest';
import { classifyFetchFailure, GarageConfigError, GarageError } from './errors';

/**
 * The point of these: before `classifyFetchFailure` existed, a refused port, a
 * bad hostname and a timeout all reached the UI as the literal string
 * "fetch failed", because undici hides the reason on `err.cause` and the client
 * discarded it. Each case below is a distinct thing an operator must fix.
 */

/** How undici actually shapes a transport failure. */
function fetchFailed(code: string): Error {
  const cause = Object.assign(new Error(code), { code });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('classifyFetchFailure', () => {
  it('reads a refused connection as unreachable', () => {
    const result = classifyFetchFailure(fetchFailed('ECONNREFUSED'));
    expect(result.code).toBe('unreachable');
    expect(result.message).toMatch(/refused/i);
  });

  it('separates a DNS miss from a refused port', () => {
    expect(classifyFetchFailure(fetchFailed('ENOTFOUND')).code).toBe('dns');
    expect(classifyFetchFailure(fetchFailed('EAI_AGAIN')).code).toBe('dns');
  });

  it('reads a TLS rejection as tls, not as unreachable', () => {
    expect(
      classifyFetchFailure(fetchFailed('ERR_TLS_CERT_ALTNAME_INVALID')).code
    ).toBe('tls');
    expect(classifyFetchFailure(fetchFailed('CERT_HAS_EXPIRED')).code).toBe(
      'tls'
    );
  });

  it('reads our own AbortController timeout as a timeout', () => {
    const abort = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    expect(classifyFetchFailure(abort).code).toBe('timeout');
  });

  it('reads a connect timeout deep in the cause chain', () => {
    expect(
      classifyFetchFailure(fetchFailed('UND_ERR_CONNECT_TIMEOUT')).code
    ).toBe('timeout');
  });

  it('falls back to unreachable for an unrecognised cause', () => {
    expect(classifyFetchFailure(new TypeError('fetch failed')).code).toBe(
      'unreachable'
    );
  });

  it('terminates on a self-referential cause chain', () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(classifyFetchFailure(looped).code).toBe('unreachable');
  });
});

describe('GarageConfigError', () => {
  it('names the missing vars and is a GarageError', () => {
    const err = new GarageConfigError(['GARAGE_ADMIN_TOKEN']);
    expect(err).toBeInstanceOf(GarageError);
    expect(err.code).toBe('not_configured');
    expect(err.missing).toEqual(['GARAGE_ADMIN_TOKEN']);
    expect(err.message).toContain('GARAGE_ADMIN_TOKEN');
  });
});
