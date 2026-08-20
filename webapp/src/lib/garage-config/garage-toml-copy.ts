import {
  GARAGE_CONFIG_REFERENCE_URL,
  GARAGE_LAYOUT_DOC_URL,
  GARAGE_REAL_WORLD_URL,
} from '@/lib/garage-docs';

/**
 * Every sentence the config generator says, in one place.
 *
 * The disclaimers *are* the feature here, in the same way `planner-copy.ts`'s
 * are: a page that hands an operator a `garage.toml` and does not say
 * out loud that it never saw a secret and never will is a page that will be
 * asked for one. Exported as constants so the tests assert what the page
 * renders by import rather than by re-typing the literal — the convention
 * `planner-copy.ts`, `data-coverage.ts` and `scrub-status.ts` already follow.
 */

/** The file this page produces. Used for the download and in the copy below. */
export const CONFIG_FILE_NAME = 'garage.toml';

export const PAGE_TITLE = 'Config generator';

export const PAGE_DESCRIPTION =
  'Build a starting `garage.toml` for a new GarageHQ cluster. Everything ' +
  'happens in your browser: nothing here is sent anywhere, saved, or applied ' +
  'to a cluster.';

/**
 * The boundary, stated on the page itself. Must not contradict
 * `NoClusterCard`'s "manages an existing GarageHQ cluster — it does not
 * install one", which is the same claim from the other end.
 */
export const NO_INSTALL_NOTICE =
  'garage-ware does not install or run GarageHQ. This generates a file you ' +
  'take to your own hosts and place at /etc/garage.toml yourself. Once those ' +
  'nodes are up you come back here and point this deployment at them.';

/**
 * The hard constraint, rendered where the operator can see it before they go
 * looking for a field to paste a secret into.
 */
export const NO_SECRETS_NOTICE =
  'This page never asks for a secret, and never generates one. The RPC secret ' +
  'and the admin token are emitted as @PLACEHOLDER@ values with the command ' +
  'that produces each one beside them — you fill those in on the host, where ' +
  'they belong. Nothing you type here is stored.';

/** The one-line safety tradeoff for each replication factor, per the reference. */
export const REPLICATION_TRADEOFFS: Readonly<Record<number, string>> = {
  3: 'Three copies of every block. The recommended setting: the cluster survives losing one node outright, and stays readable while a second is offline. Needs at least three storage nodes.',
  2: 'Two copies of every block. Survives one node failing; a second failure while the first is still down loses data. Needs at least two storage nodes.',
  1: 'One copy. No redundancy at all — losing any node loses the data it held. Only for testing, or where the data is disposable.',
};

/** Shown beside the replication control so the recommendation is not implicit. */
export const REPLICATION_RECOMMENDATION =
  'Set this once, before the cluster holds data. Changing the replication ' +
  'factor of a live cluster is an operation with its own procedure, not an ' +
  'edit to this file.';

/**
 * Why zone and capacity are a comment block instead of two more fields.
 *
 * They are genuinely not settings in `garage.toml` — they live in the cluster
 * layout and are assigned with the CLI after the nodes are running. Emitting
 * them as keys would produce a file Garage ignores, which is worse than
 * omitting them.
 */
export const LAYOUT_NOT_IN_TOML_NOTICE =
  'Zone and capacity are not settings in garage.toml — they belong to the ' +
  'cluster layout, which you assign with the garage CLI once the nodes are up ' +
  'and talking to each other. What you enter here only shapes the example ' +
  'commands in the comment block at the end of the file.';

export interface NextStep {
  title: string;
  body: string;
  /** Shown in a `<pre>` under the body. Omitted when the step is not a command. */
  command?: string;
}

/**
 * The six steps from a generated file to a connected deployment.
 *
 * Ends where garage-ware's own job starts — the last step is setting the two
 * env vars this app reads, which is the same pair `NoClusterCard` names.
 */
export const NEXT_STEPS: readonly NextStep[] = [
  {
    title: 'Place the file on every node',
    body: `Save it as /etc/garage.toml on each machine that will run Garage. The file is identical everywhere except rpc_public_addr, which has to be that node's own address.`,
  },
  {
    title: 'Fill in the placeholders',
    body: 'Generate the RPC secret once and use the same value on every node — it is what lets them trust each other. Replace @THIS_NODE_PUBLIC_IP@ per node.',
    command: 'openssl rand -hex 32',
  },
  {
    title: 'Start the nodes',
    body: 'Start Garage on each host, then check they can see one another. Use `garage node id` on one node and `garage node connect` from the others if they do not find each other on their own.',
    command: 'garage status',
  },
  {
    title: 'Assign the layout and apply it',
    body: 'Nothing is stored until every node has a zone and a capacity. Read `garage layout show` before applying — that output, not this page, is what Garage will do.',
    command: [
      'garage layout assign <node-key> -z <zone> -c <capacity> -t <name>',
      'garage layout show',
      'garage layout apply --version <n>',
    ].join('\n'),
  },
  {
    title: 'Mint an admin token for garage-ware',
    body: 'garage-ware authenticates to the admin API with a token you create after the cluster is up. It is shown once and never again, so save it straight away.',
    command: 'garage admin-token create --name garage-ware',
  },
  {
    title: 'Point this deployment at the cluster',
    body: 'Set GARAGE_ADMIN_URL to the admin API you configured above and GARAGE_ADMIN_TOKEN to the token you just minted, then restart garage-ware. /admin/status will tell you what it can and cannot reach.',
  },
];

/** Where to read the whole story rather than this page's summary of it. */
export const DOC_LINKS: readonly { href: string; label: string }[] = [
  {
    href: GARAGE_REAL_WORLD_URL,
    label: 'Production deployment cookbook',
  },
  {
    href: GARAGE_CONFIG_REFERENCE_URL,
    label: 'Configuration file reference',
  },
  {
    href: GARAGE_LAYOUT_DOC_URL,
    label: 'Cluster layout reference',
  },
];

/** Toast text, so the component test and the component agree. */
export const COPY_SUCCESS = 'Configuration copied';
export const COPY_FAILURE = 'Could not copy to the clipboard';
export const DOWNLOAD_FAILURE = `Could not download ${CONFIG_FILE_NAME}`;

/** Heading for the destructive alert that lists `configErrors()` output. */
export const INVALID_HEADING = 'This configuration would not start';
