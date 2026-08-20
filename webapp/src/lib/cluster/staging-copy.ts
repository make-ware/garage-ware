/**
 * Every sentence the layout-staging page says about where its authority stops,
 * in one place.
 *
 * Same arrangement as `planner-copy.ts`, and for a sharper reason: this page
 * writes to the operator's real cluster. The boundary — garage-ware stages, a
 * human applies — is the feature, so the page renders exactly the strings the
 * tests assert rather than two prose copies that drift apart.
 */

export const STAGE_ONLY_NOTICE =
  'garage-ware stages layout changes; it never applies them. Staging writes ' +
  'into Garage’s pending area and moves no data. Committing a staged change ' +
  'is a command you run yourself on a cluster host, after reading `garage ' +
  'layout show`.';

export const APPLY_ONCE_WARNING =
  'Apply exactly once, from one place. Review `garage layout show` first — ' +
  'that output, not this page, is what Garage will actually do. Applying ' +
  'starts real data movement and there is no undo once it has begun.';

export const NO_UNSTAGE_NOTICE =
  'A staged change cannot be un-staged from here. Only `garage layout revert` ' +
  'clears the staging area, and it is not an undo — it discards every pending ' +
  'change and increments the layout version. Run it on a cluster host if you ' +
  'want to start over; garage-ware will never run it for you.';

export const CONFLICT_COPY =
  'The cluster layout changed since this page loaded, so nothing was staged. ' +
  'Someone else may have staged a change, or applied one. Refresh, check what ' +
  'is staged now, and stage again if you still want to.';

export const EMPTY_STAGED_COPY =
  'Nothing is staged. The layout below is what the cluster is running.';

/**
 * What the staged table says about a change it cannot read. See
 * `describeStagedChanges` — `garage layout apply` commits it either way, so it
 * has to be visible.
 */
export const UNRECOGNISED_CHANGE_COPY =
  'A staged change this version does not recognise. Read `garage layout show` ' +
  'on a cluster host before applying.';

/** Staged `parameters` — the one staged thing this app never writes. */
export const STAGED_PARAMETERS_COPY =
  'Layout parameters (zone redundancy) are also staged, set from outside this ' +
  'app. `garage layout apply` will commit them together with the role changes ' +
  'below. garage-ware does not stage or display parameter changes — check ' +
  '`garage layout show`.';
