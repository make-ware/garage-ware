import * as React from 'react';

const MOBILE_BREAKPOINT = 768;
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribe(onStoreChange: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener('change', onStoreChange);
  return () => mql.removeEventListener('change', onStoreChange);
}

function getSnapshot() {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

// There is no viewport to measure while rendering on the server. React also
// uses this snapshot for the hydrating client render, so returning a constant
// keeps the two passes identical — the same reason the previous implementation
// started undefined and only learned the real width in an effect.
function getServerSnapshot() {
  return false;
}

/**
 * Subscribe to the mobile breakpoint.
 *
 * A media query is external state, so it is read through useSyncExternalStore
 * rather than mirrored into useState from an effect: that kept a second copy of
 * something the browser already tracks, and cost an extra render on every mount.
 */
export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
