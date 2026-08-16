import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeFailure,
  evaluateClaim,
  expectedClaimToken,
  isClaimed,
  markClaimed,
  tokenMatches,
  type AdminCounter,
} from './claim';

function counterWith(count: number): AdminCounter {
  return { countAdmins: async () => count };
}

describe('setup claim', () => {
  let dir: string;
  const savedDir = process.env.SETUP_STATE_DIR;
  const savedToken = process.env.SETUP_CLAIM_TOKEN;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gw-setup-'));
    process.env.SETUP_STATE_DIR = dir;
    delete process.env.SETUP_CLAIM_TOKEN;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.SETUP_STATE_DIR;
    else process.env.SETUP_STATE_DIR = savedDir;
    if (savedToken === undefined) delete process.env.SETUP_CLAIM_TOKEN;
    else process.env.SETUP_CLAIM_TOKEN = savedToken;
  });

  describe('tokenMatches', () => {
    it('accepts an exact match and rejects near misses', () => {
      expect(tokenMatches('abc123', 'abc123')).toBe(true);
      expect(tokenMatches('abc124', 'abc123')).toBe(false);
    });

    it('rejects a length mismatch without throwing', () => {
      // timingSafeEqual throws on unequal lengths; the guard must absorb that.
      expect(() => tokenMatches('short', 'much-longer-token')).not.toThrow();
      expect(tokenMatches('short', 'much-longer-token')).toBe(false);
      expect(tokenMatches('', 'tok')).toBe(false);
    });
  });

  describe('expectedClaimToken', () => {
    it('reads the token file, trimming the trailing newline', async () => {
      await writeFile(path.join(dir, 'claim-token'), 'file-token\n');
      expect(await expectedClaimToken()).toBe('file-token');
    });

    it('prefers the env var over the file', async () => {
      await writeFile(path.join(dir, 'claim-token'), 'file-token');
      process.env.SETUP_CLAIM_TOKEN = 'env-token';
      expect(await expectedClaimToken()).toBe('env-token');
    });

    it('is null when there is no token at all', async () => {
      expect(await expectedClaimToken()).toBeNull();
    });

    it('treats an empty token file as no token', async () => {
      await writeFile(path.join(dir, 'claim-token'), '   \n');
      expect(await expectedClaimToken()).toBeNull();
    });
  });

  describe('evaluateClaim', () => {
    it('accepts the right token on an unclaimed instance', async () => {
      await writeFile(path.join(dir, 'claim-token'), 'good');
      expect(await evaluateClaim(counterWith(0), 'good')).toEqual({ ok: true });
    });

    it('rejects the wrong token', async () => {
      await writeFile(path.join(dir, 'claim-token'), 'good');
      expect(await evaluateClaim(counterWith(0), 'bad!')).toEqual({
        ok: false,
        failure: 'bad-token',
      });
    });

    it('refuses once an admin exists, EVEN with the correct token', async () => {
      // The load-bearing guard. A leaked token must be inert after the claim.
      await writeFile(path.join(dir, 'claim-token'), 'good');
      expect(await evaluateClaim(counterWith(1), 'good')).toEqual({
        ok: false,
        failure: 'already-claimed',
      });
    });

    it('checks claimed-ness before the token, so a claimed instance answers the same either way', async () => {
      await writeFile(path.join(dir, 'claim-token'), 'good');
      const right = await evaluateClaim(counterWith(2), 'good');
      const wrong = await evaluateClaim(counterWith(2), 'nope');
      expect(right).toEqual(wrong);
    });

    it('reports a missing token distinctly from a wrong one', async () => {
      expect(await evaluateClaim(counterWith(0), 'anything')).toEqual({
        ok: false,
        failure: 'no-token-configured',
      });
    });
  });

  describe('markClaimed', () => {
    it('writes the marker and removes the token file', async () => {
      await writeFile(path.join(dir, 'claim-token'), 'good');
      await markClaimed();
      expect(existsSync(path.join(dir, 'claimed'))).toBe(true);
      expect(existsSync(path.join(dir, 'claim-token'))).toBe(false);
    });

    it('is safe to call when there is no token file', async () => {
      await expect(markClaimed()).resolves.toBeUndefined();
    });
  });

  describe('isClaimed', () => {
    it('is false at zero admins and true above', async () => {
      expect(await isClaimed(counterWith(0))).toBe(false);
      expect(await isClaimed(counterWith(1))).toBe(true);
    });
  });

  describe('describeFailure', () => {
    it('maps each failure to a status and a message that says what to do', () => {
      expect(describeFailure('already-claimed').status).toBe(409);
      expect(describeFailure('no-token-configured').status).toBe(409);
      expect(describeFailure('bad-token').status).toBe(403);
      expect(describeFailure('no-token-configured').error).toMatch(/logs/i);
    });
  });
});

/**
 * Guard the ordering property the route's in-process queue depends on: the
 * claimed check must be a strict precondition, so a serialised second attempt
 * sees the admin the first one created.
 */
describe('sequential claims', () => {
  it('refuses the second attempt once the first has taken the seat', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const pathMod = await import('node:path');
    const dir = await mkdtemp(pathMod.join(tmpdir(), 'gw-seq-'));
    const prev = process.env.SETUP_STATE_DIR;
    process.env.SETUP_STATE_DIR = dir;
    try {
      await writeFile(pathMod.join(dir, 'claim-token'), 'tok');
      let admins = 0;
      const counter = { countAdmins: async () => admins };

      const first = await evaluateClaim(counter, 'tok');
      expect(first.ok).toBe(true);
      admins = 1; // the route creates the row inside the same lock

      const second = await evaluateClaim(counter, 'tok');
      expect(second).toEqual({ ok: false, failure: 'already-claimed' });
    } finally {
      await rm(dir, { recursive: true, force: true });
      if (prev === undefined) delete process.env.SETUP_STATE_DIR;
      else process.env.SETUP_STATE_DIR = prev;
    }
  });
});
