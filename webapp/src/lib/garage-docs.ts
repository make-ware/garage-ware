/**
 * Links into Garage's own documentation, for the case where this deployment
 * cannot reach a cluster at all.
 *
 * garage-ware **manages** a Garage cluster; it never installs, runs or stores
 * credentials for one. So the only thing it can usefully offer an operator with
 * no cluster is a pointer at the upstream docs — which is all this file is.
 *
 * Deliberately at the top of `lib/`, not under `lib/garage/`: every file there
 * starts `import 'server-only'`, and these constants are rendered by client
 * components. Same escape hatch as `node-label.ts` and `storage/units.ts`. Not
 * in `setup/diagnostics.ts` either — that file's docblock is explicit that
 * nothing about rendering belongs in the collection of the facts, and the
 * `/dashboard/cluster` consumer has nothing to do with diagnostics.
 */

/** Safe on any page: the project's front door, no operational detail. */
export const GARAGE_HOME_URL = 'https://garagehq.deuxfleurs.fr/';

/**
 * The upstream pages the config generator cites, one const each.
 *
 * `lib/garage-config/garage-toml.ts` builds a per-key `#anchor` link onto
 * `GARAGE_CONFIG_REFERENCE_URL` for every line it emits, and the card below
 * links the same page. Two string literals of the same URL in two files is how
 * one of them silently rots, so there is only ever one.
 */
export const GARAGE_QUICK_START_URL =
  'https://garagehq.deuxfleurs.fr/documentation/quick-start/';
export const GARAGE_CONFIG_REFERENCE_URL =
  'https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/';
export const GARAGE_REAL_WORLD_URL =
  'https://garagehq.deuxfleurs.fr/documentation/cookbook/real-world/';
/**
 * Note the path: `operations/layout`, not `reference-manual/layout` — the
 * latter is a 404 upstream.
 */
export const GARAGE_LAYOUT_DOC_URL =
  'https://garagehq.deuxfleurs.fr/documentation/operations/layout/';

export interface GarageDocLink {
  href: string;
  title: string;
  blurb: string;
}

/**
 * ADMIN-ONLY. Never render these on a user-facing page — `/dashboard/cluster`
 * is redacted for regular users and gets `GARAGE_HOME_URL` instead. The
 * `_ADMIN_` in the name is the tell: this imported into `components/cluster/`
 * is a bug.
 */
export const GARAGE_ADMIN_DOC_LINKS: readonly GarageDocLink[] = [
  {
    href: GARAGE_QUICK_START_URL,
    title: 'Installation quickstart',
    blurb: 'Get a single Garage node running and talking S3.',
  },
  {
    href: GARAGE_CONFIG_REFERENCE_URL,
    title: 'Configuration file reference',
    blurb:
      'Every option in garage.toml, including the admin block that exposes the API this app calls.',
  },
  {
    href: GARAGE_REAL_WORLD_URL,
    title: 'Production deployment cookbook',
    blurb: 'Running a multi-node cluster for real, with a layout applied.',
  },
];
