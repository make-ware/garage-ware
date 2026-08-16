/**
 * Who may create an account.
 *
 * Enforcement has to live in a PocketBase hook, not a Next.js route: sign-up is
 * a direct client-side PB call (`AuthService.register` -> `userMutator.create`),
 * so nothing server-side of ours is on that path. It is a hook rather than a
 * collection rule because the mode is env-driven, and a rule change would mean
 * a migration every time an operator changed their mind.
 *
 * This file holds only the DECISION, with no Goja globals, no `require`, and no
 * clock — so vitest can drive it from the webapp workspace the same way
 * cluster-events-lib.test.ts drives diffObservations. main.pb.js does the I/O
 * and throws; this says what should happen.
 */

/** Fallback when SIGNUP_MODE is unset or unrecognised. */
const DEFAULT_SIGNUP_MODE = "invite";

const SIGNUP_MODES = ["invite", "open", "closed"];

/**
 * An unrecognised value falls back to `invite`, never to `open` — a typo in
 * this variable must not silently throw the doors open. Keep in step with
 * webapp/src/lib/setup/signup-mode.ts, which parses the same values for display.
 */
function parseSignupMode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return SIGNUP_MODES.indexOf(value) !== -1 ? value : DEFAULT_SIGNUP_MODE;
}

/**
 * Decide whether a sign-up should be allowed.
 *
 * @param {object} input
 * @param {string} input.mode           parsed signup mode
 * @param {string} input.email          lowercased address being registered
 * @param {boolean} input.isSuperuser   was this create made with superuser auth
 * @param {number} input.adminCount     how many app admins exist
 * @param {boolean} input.hasPendingInvite  is storage already waiting for this address
 * @param {string} [input.ownerEmail]   SETUP_OWNER_EMAIL, lowercased
 * @returns {{allow: boolean, reason: string}}
 */
function decideSignup(input) {
  // The admin invite path (POST /next-api/garage/users) creates the record with
  // a superuser client. It has already done its own admin check; gating it here
  // would break the one flow that is supposed to bypass public sign-up.
  if (input.isSuperuser) {
    return { allow: true, reason: "superuser" };
  }

  // Bootstrap window. With no admin yet there is nobody to invite anyone, so a
  // closed instance would lock its own owner out before they could claim it.
  // Sign-up here still grants nothing — claiming the admin seat needs the token.
  if (!input.adminCount) {
    return { allow: true, reason: "unclaimed-instance" };
  }

  if (input.mode === "open") {
    return { allow: true, reason: "open-signups" };
  }

  if (input.mode === "closed") {
    return { allow: false, reason: "signups-closed" };
  }

  // invite mode
  if (input.ownerEmail && input.email === input.ownerEmail) {
    return { allow: true, reason: "setup-owner" };
  }
  if (input.hasPendingInvite) {
    return { allow: true, reason: "pending-invite" };
  }
  return { allow: false, reason: "invite-required" };
}

/** The message a rejected sign-up sees. Never says whether the address exists. */
function refusalMessage(reason) {
  if (reason === "signups-closed") {
    return "Sign-ups are disabled on this instance. Ask an administrator to create your account.";
  }
  return "Sign-ups on this instance are invite only. Ask an administrator to invite you, or to send you a storage transfer at this address.";
}

module.exports = {
  DEFAULT_SIGNUP_MODE,
  SIGNUP_MODES,
  parseSignupMode,
  decideSignup,
  refusalMessage,
};
