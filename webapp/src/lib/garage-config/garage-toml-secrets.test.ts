import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN_PLACEHOLDER,
  configErrors,
  DEFAULT_CONFIG_INPUT,
  generateGarageToml,
  REPLICATION_FACTORS,
  RPC_SECRET_PLACEHOLDER,
  type GarageConfigInput,
} from './garage-toml';

/**
 * The boundary guard: **this page never handles a secret.**
 *
 * The constraint is a product decision, not a bug class — an admin console that
 * accepts an RPC secret into a form field has invented a way to get one into a
 * browser history, a screenshot, a support ticket and a React devtools tree, in
 * exchange for saving an operator one `openssl` invocation. So the generator
 * emits `@PLACEHOLDER@` tokens and the host fills them in.
 *
 * Intent is not enforcement, so this is structural, sibling to
 * `layout-sim-boundary.test.ts` and `node-id-boundary.test.ts`: it fails for
 * the next person without them having to remember the rule. Three separate
 * assertions, because a future change could break any one of them alone —
 * the input type could grow a `rpcSecret` field, the module could grow a
 * `crypto.getRandomValues` call, or the emitter could start interpolating
 * something secret-shaped that neither of the first two would catch.
 */

const MODULE_PATH = path.join(import.meta.dirname, 'garage-toml.ts');

/** The vocabulary of a credential, as it would appear in an identifier or label. */
const SECRET_WORDS = /secret|token|password|passphrase|credential|api[_-]?key/i;

/** 32+ hex characters in a row: an RPC secret, a key id, a hash. */
const HEX_RUN = /[0-9a-f]{32,}/i;

/** 32+ base64 characters in a row: an access key, a bearer token. */
const BASE64_RUN = /[A-Za-z0-9+/]{32,}={0,2}/;

/**
 * Strip block and line comments before scanning source for a forbidden call.
 *
 * Without this the docblock above, which has to *name* what it forbids, trips
 * the guard describing itself — the same trap `layout-sim-boundary.test.ts`
 * sidesteps.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Documentation URLs are long runs of base64-legal characters and are not
 * secrets. Removing them first keeps the run detectors meaningful instead of
 * permanently red.
 */
function withoutUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, '');
}

/** A spread of inputs wide enough that a leak would have to dodge all of them. */
function permutations(): GarageConfigInput[] {
  const inputs: GarageConfigInput[] = [];
  for (const replicationFactor of REPLICATION_FACTORS) {
    for (const s3RootDomain of ['', '.s3.example.com']) {
      for (const bindHost of ['[::]', '0.0.0.0', '127.0.0.1']) {
        for (const nodeCount of [1, 3, 8]) {
          inputs.push({
            ...DEFAULT_CONFIG_INPUT,
            replicationFactor,
            s3RootDomain,
            bindHost,
            nodeCount,
            metadataDir: `/srv/${bindHost === '[::]' ? 'meta' : 'metadata'}`,
            dataDir: '/srv/data',
            rpcPort: 3901 + nodeCount,
            s3ApiPort: 3900,
            adminApiPort: 3903,
            zone: `zone-${nodeCount}`,
            capacity: `${nodeCount}T`,
          });
        }
      }
    }
  }
  return inputs;
}

describe('the config generator never handles a secret', () => {
  it('covers a real spread of inputs', () => {
    // A permutation set that silently collapsed to one case would make every
    // assertion below vacuously true.
    const inputs = permutations();
    expect(inputs.length).toBeGreaterThan(20);
    expect(new Set(inputs.map(generateGarageToml)).size).toBe(inputs.length);
  });

  it('emits no secret-shaped run for any input', () => {
    for (const input of permutations()) {
      const emitted = withoutUrls(generateGarageToml(input));
      expect(emitted).not.toMatch(HEX_RUN);
      expect(emitted).not.toMatch(BASE64_RUN);
    }
  });

  it('emits placeholders where the credentials go', () => {
    for (const input of permutations()) {
      const toml = generateGarageToml(input);
      expect(toml).toContain(RPC_SECRET_PLACEHOLDER);
      expect(toml).toContain(ADMIN_TOKEN_PLACEHOLDER);
    }
  });

  it('has no field on GarageConfigInput that names a credential', () => {
    // The type is erased at runtime, so the check is on the source of the one
    // value that must have every key: the defaults.
    for (const key of Object.keys(DEFAULT_CONFIG_INPUT)) {
      expect(key).not.toMatch(SECRET_WORDS);
    }

    const interfaceBody = readFileSync(MODULE_PATH, 'utf8').match(
      /export interface GarageConfigInput \{([\s\S]*?)\n\}/
    );
    if (!interfaceBody)
      throw new Error('GarageConfigInput is no longer an interface');
    for (const field of interfaceBody[1].matchAll(/^\s{2}(\w+)\s*[?:]/gm)) {
      expect(field[1]).not.toMatch(SECRET_WORDS);
    }
  });

  it('never reaches for a source of randomness', () => {
    // Generating a secret in the browser and putting it in the download would
    // satisfy the form while defeating the whole point.
    const source = code(readFileSync(MODULE_PATH, 'utf8'));
    expect(source).not.toMatch(
      /getRandomValues|randomUUID|Math\.random|randomBytes/
    );
    expect(source).not.toMatch(/\bcrypto\b/);
  });

  it('imports nothing server-only, so it cannot reach a real token', () => {
    // `lib/garage/` holds GARAGE_ADMIN_TOKEN's only reader. This module is
    // bundled into the browser, so an import from there is both a build error
    // and a leak — assert it before either can happen.
    const source = readFileSync(MODULE_PATH, 'utf8');
    expect(source).not.toMatch(/from\s+['"][^'"]*lib\/garage\/[^'"]*['"]/);
    expect(source).not.toMatch(/from\s+['"]server-only['"]/);
    expect(source).not.toMatch(/process\.env/);
  });

  it('does not validate, and therefore does not read, anything secret', () => {
    // A validator that checked "is this a well-formed RPC secret" would mean a
    // secret had reached the form.
    const source = code(readFileSync(MODULE_PATH, 'utf8'));
    const validator = source.match(
      /export function configErrors[\s\S]*?\n\}\n/
    );
    if (!validator)
      throw new Error('configErrors is no longer a function declaration');
    expect(validator[0]).not.toMatch(SECRET_WORDS);
    expect(configErrors(DEFAULT_CONFIG_INPUT)).toEqual([]);
  });
});
