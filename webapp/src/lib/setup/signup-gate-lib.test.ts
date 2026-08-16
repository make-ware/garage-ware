import { describe, expect, it } from 'vitest';
// The signup decision lives in the PocketBase hooks, because sign-up is a
// direct client-side PB call that nothing server-side of ours sits on. Imported
// across the workspace boundary for the same reason as cluster-events.js: it
// decides who can get into the instance, and it runs somewhere with no test
// runner. Its top level touches no Goja globals and makes no requires.
import {
  decideSignup,
  parseSignupMode,
  refusalMessage,
} from '../../../../pocketbase/pb_hooks/lib/signup-gate.js';
import { parseSignupMode as parseInWebapp } from './signup-mode';

interface SignupInput {
  mode: string;
  email: string;
  isSuperuser: boolean;
  adminCount: number;
  hasPendingInvite: boolean;
  ownerEmail?: string;
}

const base: SignupInput = {
  mode: 'invite',
  email: 'newcomer@example.com',
  isSuperuser: false,
  adminCount: 1,
  hasPendingInvite: false,
};

const decide = (over: Partial<SignupInput> = {}) =>
  decideSignup({ ...base, ...over }) as { allow: boolean; reason: string };

describe('parseSignupMode', () => {
  it('accepts the three modes case-insensitively', () => {
    expect(parseSignupMode('open')).toBe('open');
    expect(parseSignupMode('  Closed ')).toBe('closed');
    expect(parseSignupMode('INVITE')).toBe('invite');
  });

  it('falls back to invite — never open — for junk or absence', () => {
    // A typo in SIGNUP_MODE must not throw the doors open.
    expect(parseSignupMode('opne')).toBe('invite');
    expect(parseSignupMode(undefined)).toBe('invite');
    expect(parseSignupMode('')).toBe('invite');
  });

  it('agrees with the webapp-side parser it must stay in step with', () => {
    for (const v of ['open', 'closed', 'invite', 'junk', '', undefined]) {
      expect(parseSignupMode(v)).toBe(parseInWebapp(v));
    }
  });
});

describe('decideSignup', () => {
  it('always lets a superuser-created record through', () => {
    // This is the admin invite path, which has already done its own admin check.
    expect(decide({ isSuperuser: true, mode: 'closed' })).toMatchObject({
      allow: true,
      reason: 'superuser',
    });
  });

  it('stays open while no admin exists, so a fresh install cannot lock its owner out', () => {
    expect(decide({ adminCount: 0, mode: 'closed' })).toMatchObject({
      allow: true,
      reason: 'unclaimed-instance',
    });
    expect(decide({ adminCount: 0, mode: 'invite' }).allow).toBe(true);
  });

  it('rejects a cold sign-up in invite mode once an admin exists', () => {
    expect(decide()).toMatchObject({ allow: false, reason: 'invite-required' });
  });

  it('admits an address that already holds a pending storage invite', () => {
    expect(decide({ hasPendingInvite: true })).toMatchObject({
      allow: true,
      reason: 'pending-invite',
    });
  });

  it('admits the configured setup owner', () => {
    expect(
      decide({ ownerEmail: 'owner@example.com', email: 'owner@example.com' })
    ).toMatchObject({ allow: true, reason: 'setup-owner' });
  });

  it('does not admit a near-miss of the setup owner address', () => {
    expect(
      decide({ ownerEmail: 'owner@example.com', email: 'owner@example.co' })
    ).toMatchObject({ allow: false });
  });

  it('honours open mode', () => {
    expect(decide({ mode: 'open' })).toMatchObject({
      allow: true,
      reason: 'open-signups',
    });
  });

  it('honours closed mode even for an invited address', () => {
    // Closed means closed: an outstanding storage invite is not a way in.
    expect(decide({ mode: 'closed', hasPendingInvite: true })).toMatchObject({
      allow: false,
      reason: 'signups-closed',
    });
  });
});

describe('refusalMessage', () => {
  it('never reveals whether the address already has an account', () => {
    for (const reason of ['signups-closed', 'invite-required']) {
      const msg = refusalMessage(reason) as string;
      expect(msg).not.toMatch(/exist|already|taken|registered/i);
      expect(msg.length).toBeGreaterThan(20);
    }
  });
});
