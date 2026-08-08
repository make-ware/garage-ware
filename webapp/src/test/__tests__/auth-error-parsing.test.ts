import { describe, it, expect } from 'vitest';
import {
  parseAuthError,
  getFieldError,
  getErrorMessage,
} from '@garage-ware/shared';

/**
 * PocketBase's JS SDK throws a ClientResponseError whose `data` is the raw
 * response body. Reproduced as a plain object so these tests don't need the SDK.
 */
function clientResponseError(
  status: number,
  body: Record<string, unknown>
): Error & { status: number; data: Record<string, unknown> } {
  // The SDK sets `.message` from the body's message, falling back to its own
  // placeholder — see ClientResponseError in the pocketbase package.
  const err = new Error(
    (body.message as string) || 'Something went wrong.'
  ) as Error & { status: number; data: Record<string, unknown> };
  err.name = 'ClientResponseError';
  err.status = status;
  err.data = body;
  return err;
}

describe('parseAuthError', () => {
  describe('failed login', () => {
    // Verified against PocketBase 0.35.0:
    //   POST /api/collections/Users/auth-with-password (bad password)
    //   -> {"data":{},"message":"Failed to authenticate.","status":400}
    // The empty-but-truthy `data` used to be read as "field errors are present",
    // which surfaced the generic 'Invalid input data.' to the user.
    const wrongPassword = () =>
      clientResponseError(400, {
        data: {},
        message: 'Failed to authenticate.',
        status: 400,
      });

    it('classifies an empty-data 400 as an authentication failure', () => {
      const parsed = parseAuthError(wrongPassword());
      expect(parsed.type).toBe('authentication');
      expect(parsed.message).toBe(
        'Invalid credentials. Please check your email and password.'
      );
    });

    it('never surfaces the generic validation message', () => {
      expect(getErrorMessage(wrongPassword())).not.toBe('Invalid input data.');
    });

    it('maps to both credential fields for form highlighting', () => {
      const err = wrongPassword();
      expect(getFieldError(err, 'email')).toBe('Invalid email or password.');
      expect(getFieldError(err, 'password')).toBe('Invalid email or password.');
    });

    it('survives being re-thrown as a plain Error by the service layer', () => {
      // AuthService.login / AuthProvider.login both re-wrap with
      // `new Error(parsedError.message)`, so the form re-parses a plain Error.
      const rewrapped = new Error(parseAuthError(wrongPassword()).message);
      expect(parseAuthError(rewrapped).type).toBe('authentication');
    });
  });

  describe('field-scoped 400s still work', () => {
    it('reports the field message and name', () => {
      const err = clientResponseError(400, {
        data: {
          email: {
            code: 'validation_invalid_email',
            message: 'Must be a valid email address.',
          },
        },
        message: 'Failed to create record.',
        status: 400,
      });

      const parsed = parseAuthError(err);
      expect(parsed.type).toBe('validation');
      expect(parsed.field).toBe('email');
      expect(parsed.message).toBe('Must be a valid email address.');
      expect(getFieldError(err, 'email')).toBe(
        'Must be a valid email address.'
      );
    });

    it('treats a password field error as an authentication failure', () => {
      const parsed = parseAuthError(
        clientResponseError(400, {
          data: {
            password: {
              code: 'validation_invalid_credentials',
              message: 'Invalid login credentials.',
            },
          },
          message: 'Failed to authenticate.',
          status: 400,
        })
      );
      expect(parsed.type).toBe('authentication');
    });
  });

  describe('other statuses are unchanged', () => {
    it('handles a 400 with no data at all', () => {
      const parsed = parseAuthError(clientResponseError(400, {}));
      expect(parsed.type).toBe('validation');
      // The SDK's own placeholder must not leak through as the message.
      expect(parsed.message).toBe('Invalid request data.');
    });

    it('handles 401', () => {
      expect(parseAuthError(clientResponseError(401, {})).type).toBe(
        'authentication'
      );
    });

    it('handles 429', () => {
      const parsed = parseAuthError(clientResponseError(429, {}));
      expect(parsed.type).toBe('server');
      expect(parsed.message).toContain('Too many requests');
    });

    it('handles a network failure', () => {
      const err = new TypeError('Failed to fetch');
      expect(parseAuthError(err).type).toBe('network');
    });
  });
});
