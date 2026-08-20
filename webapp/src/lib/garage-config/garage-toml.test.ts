import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import {
  ADMIN_TOKEN_PLACEHOLDER,
  configErrors,
  DEFAULT_CONFIG_INPUT,
  generateGarageToml,
  PUBLIC_ADDR_PLACEHOLDER,
  RPC_SECRET_PLACEHOLDER,
  type GarageConfigInput,
} from './garage-toml';

/**
 * The generator's contract has two halves, and both are asserted here.
 *
 * The *approved artifact* half is the file snapshot: `garage.default.toml` is
 * reviewed as part of the PR and is byte-for-byte what an operator downloads
 * with the form untouched. A `.toml` fixture rather than an inline snapshot so
 * the thing under review reads as the thing being shipped — and `.toml` is
 * outside prettier's glob, so it cannot be reformatted out from under the test.
 *
 * The *validity* half is the round-trip: we hand-roll TOML emission, so the
 * only assertion that proves the output is really TOML rather than
 * plausible-looking is parsing it with a parser that did not come from this
 * file.
 */

function parsed(input: GarageConfigInput) {
  return parse(generateGarageToml(input)) as Record<string, never>;
}

describe('generateGarageToml', () => {
  it('matches the approved default output', async () => {
    await expect(generateGarageToml(DEFAULT_CONFIG_INPUT)).toMatchFileSnapshot(
      './__snapshots__/garage.default.toml'
    );
  });

  it('parses as TOML with the defaults', () => {
    const config = parsed(DEFAULT_CONFIG_INPUT);

    expect(config.replication_factor).toBe(3);
    expect(config.metadata_dir).toBe('/var/lib/garage/meta');
    expect(config.data_dir).toBe('/var/lib/garage/data');
    expect(config.db_engine).toBe('lmdb');
    expect(config.rpc_bind_addr).toBe('[::]:3901');
    expect(config.bootstrap_peers).toEqual([]);
    expect(config.s3_api).toMatchObject({
      s3_region: 'garage',
      api_bind_addr: '[::]:3900',
    });
    expect(config.admin).toMatchObject({ api_bind_addr: '[::]:3903' });
  });

  it('parses as TOML with every field changed from its default', () => {
    const config = parsed({
      metadataDir: '/srv/garage/metadata',
      dataDir: '/srv/garage/blocks',
      replicationFactor: 2,
      bindHost: '0.0.0.0',
      rpcPort: 4901,
      s3Region: 'eu-north',
      s3ApiPort: 4900,
      s3RootDomain: '.s3.example.com',
      adminApiPort: 4903,
      zone: 'rack-b',
      capacity: '4T',
      nodeCount: 5,
    });

    expect(config.replication_factor).toBe(2);
    expect(config.metadata_dir).toBe('/srv/garage/metadata');
    expect(config.rpc_bind_addr).toBe('0.0.0.0:4901');
    expect(config.rpc_public_addr).toBe(`${PUBLIC_ADDR_PLACEHOLDER}:4901`);
    expect(config.s3_api).toMatchObject({
      s3_region: 'eu-north',
      api_bind_addr: '0.0.0.0:4900',
      root_domain: '.s3.example.com',
    });
    expect(config.admin).toMatchObject({ api_bind_addr: '0.0.0.0:4903' });
  });

  it('omits root_domain entirely when it is blank', () => {
    // Not emitted commented-out: a key the operator has to reason about is
    // worse than no key, and vhost addressing is the optional half of S3.
    const config = parsed(DEFAULT_CONFIG_INPUT);
    expect(config.s3_api).not.toHaveProperty('root_domain');
    expect(generateGarageToml(DEFAULT_CONFIG_INPUT)).not.toContain(
      'root_domain ='
    );
  });

  it('emits replication_factor, never the v0.x replication_mode spelling', () => {
    // This app speaks admin API v2; `replication_mode` is the v0.x key and a
    // current Garage will not accept it. Emitting it would hand the operator a
    // file their binary rejects — the exact failure this page exists to stop.
    for (const factor of [3, 2, 1] as const) {
      const toml = generateGarageToml({
        ...DEFAULT_CONFIG_INPUT,
        replicationFactor: factor,
        nodeCount: 5,
      });
      expect(toml).toContain(`replication_factor = ${factor}`);
      expect(toml).not.toContain('replication_mode');
      expect(
        parsed({
          ...DEFAULT_CONFIG_INPUT,
          replicationFactor: factor,
          nodeCount: 5,
        }).replication_factor
      ).toBe(factor);
    }
  });

  it('leaves both credentials as placeholders, with the command to fill each', () => {
    const toml = generateGarageToml(DEFAULT_CONFIG_INPUT);

    expect(toml).toContain(`rpc_secret = "${RPC_SECRET_PLACEHOLDER}"`);
    expect(toml).toContain('openssl rand -hex 32');
    expect(toml).toContain('garage admin-token create --name garage-ware');

    // The master token is emitted commented out: Garage v2 discourages it in
    // favour of `garage admin-token create`, so the file must not read as
    // though setting it is the expected path.
    expect(toml).toContain(`# admin_token = "${ADMIN_TOKEN_PLACEHOLDER}"`);
    expect(parsed(DEFAULT_CONFIG_INPUT).admin).not.toHaveProperty(
      'admin_token'
    );
  });

  it('states that zone and capacity are layout settings, not config keys', () => {
    const toml = generateGarageToml(DEFAULT_CONFIG_INPUT);

    expect(toml).toContain('Zone and capacity are NOT settings in this file');
    expect(toml).toContain('garage layout apply --version');
    // …and they really are absent from the parsed config, not merely disclaimed.
    const config = parsed(DEFAULT_CONFIG_INPUT);
    expect(config).not.toHaveProperty('zone');
    expect(config).not.toHaveProperty('capacity');
  });

  it('writes one example assign line per planned node', () => {
    const toml = generateGarageToml({
      ...DEFAULT_CONFIG_INPUT,
      nodeCount: 4,
      zone: 'rack-a',
      capacity: '2T',
    });
    const assigns = toml
      .split('\n')
      // `<node1-key>`, not the generic `<node-key>` template line above them.
      .filter((line) => /garage layout assign <node\d+-key>/.test(line));

    expect(assigns).toHaveLength(4);
    expect(assigns[0]).toContain('<node1-key> -z rack-a -c 2T -t node1');
    expect(assigns[3]).toContain('<node4-key> -z rack-a -c 2T -t node4');
  });

  it('links every emitted key to its own anchor in the reference', () => {
    const toml = generateGarageToml({
      ...DEFAULT_CONFIG_INPUT,
      s3RootDomain: '.s3.example.com',
    });
    // Three of these are not the key name — a derived anchor would 404 to the
    // top of the page silently, so the spellings are asserted.
    for (const anchor of [
      '#replication_factor',
      '#metadata_dir',
      '#data_dir',
      '#db_engine',
      '#rpc_secret',
      '#rpc_bind_addr',
      '#rpc_public_addr',
      '#bootstrap_peers',
      '#s3_region',
      '#s3_api_bind_addr',
      '#s3_root_domain',
      '#admin_api_bind_addr',
      '#admin_token',
    ]) {
      expect(toml).toContain(
        `https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/${anchor}`
      );
    }
  });

  it('escapes a path that would otherwise break out of its TOML string', () => {
    const config = parsed({
      ...DEFAULT_CONFIG_INPUT,
      metadataDir: '/var/lib/"garage"\\meta',
    });
    expect(config.metadata_dir).toBe('/var/lib/"garage"\\meta');
  });

  it('trims whitespace rather than emitting it into the file', () => {
    const config = parsed({
      ...DEFAULT_CONFIG_INPUT,
      metadataDir: '  /var/lib/garage/meta  ',
      s3Region: ' garage ',
    });
    expect(config.metadata_dir).toBe('/var/lib/garage/meta');
    expect(config.s3_api).toMatchObject({ s3_region: 'garage' });
  });
});

describe('configErrors', () => {
  const withInput = (overrides: Partial<GarageConfigInput>) =>
    configErrors({ ...DEFAULT_CONFIG_INPUT, ...overrides });

  it('accepts the defaults', () => {
    expect(configErrors(DEFAULT_CONFIG_INPUT)).toEqual([]);
  });

  it('rejects a blank directory', () => {
    expect(withInput({ metadataDir: '   ' })).toContainEqual(
      expect.stringContaining('Metadata directory is required')
    );
  });

  it('rejects a relative path', () => {
    expect(withInput({ dataDir: 'var/lib/garage/data' })).toContainEqual(
      expect.stringContaining('must be an absolute path')
    );
  });

  it('rejects metadata and data sharing one directory', () => {
    expect(
      withInput({ metadataDir: '/srv/garage', dataDir: '/srv/garage' })
    ).toContainEqual(expect.stringContaining('must differ'));
  });

  it('rejects an out-of-range port', () => {
    expect(withInput({ rpcPort: 0 })).toContainEqual(
      expect.stringContaining('RPC port must be a whole number')
    );
    expect(withInput({ adminApiPort: 70000 })).toContainEqual(
      expect.stringContaining('Admin API port must be a whole number')
    );
    expect(withInput({ s3ApiPort: 3900.5 })).toContainEqual(
      expect.stringContaining('S3 API port must be a whole number')
    );
  });

  it('rejects two listeners sharing a port', () => {
    expect(withInput({ adminApiPort: 3900 })).toContainEqual(
      expect.stringContaining('must all differ')
    );
  });

  it('rejects fewer nodes than the replication factor needs', () => {
    expect(withInput({ replicationFactor: 3, nodeCount: 2 })).toContainEqual(
      expect.stringContaining('needs at least 3 storage nodes')
    );
    expect(withInput({ replicationFactor: 1, nodeCount: 1 })).toEqual([]);
  });

  it('rejects a root domain without its leading dot', () => {
    expect(withInput({ s3RootDomain: 's3.example.com' })).toContainEqual(
      expect.stringContaining('must start with a dot')
    );
    expect(withInput({ s3RootDomain: '.s3.example.com' })).toEqual([]);
  });

  it('rejects a capacity Garage would not parse', () => {
    expect(withInput({ capacity: 'lots' })).toContainEqual(
      expect.stringContaining('Capacity must be a number')
    );
    for (const capacity of ['1T', '1.5T', '500G', '1099511627776']) {
      expect(withInput({ capacity })).toEqual([]);
    }
  });

  it('rejects a blank or whitespace-bearing region and zone', () => {
    expect(withInput({ s3Region: '' })).toContainEqual(
      expect.stringContaining('S3 region is required')
    );
    expect(withInput({ s3Region: 'eu west' })).toContainEqual(
      expect.stringContaining('S3 region cannot contain whitespace')
    );
    expect(withInput({ zone: '' })).toContainEqual(
      expect.stringContaining('Zone is required')
    );
  });

  it('still produces parseable TOML for input it rejects', () => {
    // The preview stays live while the alert explains what is wrong: an
    // operator fixing a port should not watch the file they are building
    // disappear.
    const bad = { ...DEFAULT_CONFIG_INPUT, rpcPort: 0, nodeCount: 1 };
    expect(configErrors(bad).length).toBeGreaterThan(0);
    expect(() => parse(generateGarageToml(bad))).not.toThrow();
  });
});
