/**
 * Who may create an account on this deployment.
 *
 * Deliberately NOT `server-only`: `/setup` renders what the mode is, and the
 * parsing has to agree with the PocketBase hook that enforces it
 * (pb_hooks/lib/signup-gate.js). Two hand-rolled parsers is how those would
 * come to disagree about what an unrecognised value means.
 */
export const SIGNUP_MODES = ['invite', 'open', 'closed'] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

export const DEFAULT_SIGNUP_MODE: SignupMode = 'closed';

/**
 * Parse a configured mode, falling back to the default.
 *
 * An unset or unrecognised value falls back to `closed`, never `open`: sign-up
 * is off unless an operator explicitly enables it, and a typo in this variable
 * must not silently throw the doors open.
 */
export function parseSignupMode(raw: string | undefined | null): SignupMode {
  const value = (raw ?? '').trim().toLowerCase();
  return (SIGNUP_MODES as readonly string[]).includes(value)
    ? (value as SignupMode)
    : DEFAULT_SIGNUP_MODE;
}

export function effectiveSignupMode(): SignupMode {
  return parseSignupMode(process.env.SIGNUP_MODE);
}
