/**
 * Number formatting shared by the hooks and crons.
 *
 * A plain `.js`, not a `.pb.js` — PocketBase loads the latter as hook files in
 * their own right. Goja gives every callback a fresh executor, so top-level
 * declarations in main.pb.js are invisible inside handlers; anything shared has
 * to be `require`d from within each one. See the note in claim-audit.js.
 *
 * These mirror webapp/src/lib/format.ts so an email and the dashboard describe
 * the same number the same way — decimal (SI) units, trailing zeros stripped.
 */

/** Raw bytes as B / KB / MB / GB / TB / PB. */
function formatBytes(bytes) {
  if (!isFinite(bytes)) return String(bytes);
  const KB = 1e3, MB = 1e6, GB = 1e9, TB = 1e12, PB = 1e15;
  const abs = Math.abs(bytes);
  let value, unit;
  if (abs >= PB) { value = bytes / PB; unit = "PB"; }
  else if (abs >= TB) { value = bytes / TB; unit = "TB"; }
  else if (abs >= GB) { value = bytes / GB; unit = "GB"; }
  else if (abs >= MB) { value = bytes / MB; unit = "MB"; }
  else if (abs >= KB) { value = bytes / KB; unit = "KB"; }
  else return bytes + " B";
  let s = value.toFixed(2);
  if (s.indexOf(".") !== -1) s = s.replace(/\.?0+$/, "");
  return s + " " + unit;
}

/**
 * A quota_gb (stored as binary GiB) as a decimal GB/TB string.
 * Bridges through bytes so it matches what the dashboard renders.
 */
function formatGib(gib) {
  return formatBytes(gib * 1024 * 1024 * 1024);
}

/**
 * Thousands separators. Goja's Intl support is limited, so this is done by
 * hand rather than through Number.prototype.toLocaleString.
 */
function formatCount(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

module.exports = { formatBytes, formatGib, formatCount };
