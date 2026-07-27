const fs = require("fs");
const path = require("path");

const CACHE_ROOT = path.join(__dirname, "..", "data", "cache");

function cachePath(namespace, key) {
  const dir = path.join(CACHE_ROOT, namespace);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${key}.json`);
}

/**
 * Read a cache entry. Returns null if missing.
 * Entry shape: { fetchedAt: <ms epoch>, data: <any> }
 */
function read(namespace, key) {
  const p = cachePath(namespace, key);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null; // corrupt cache file — treat as missing
  }
}

function write(namespace, key, data) {
  const p = cachePath(namespace, key);
  fs.writeFileSync(p, JSON.stringify({ fetchedAt: Date.now(), data }, null, 2));
}

function isStale(entry, maxAgeMs) {
  if (!entry) return true;
  return Date.now() - entry.fetchedAt > maxAgeMs;
}

function ageDays(entry) {
  if (!entry) return null;
  return +((Date.now() - entry.fetchedAt) / 86400000).toFixed(1);
}

/**
 * Get-or-fetch: serves cached data unless it's missing or stale,
 * in which case it calls fetchFn(), caches the result, and returns it.
 * This is the piece that keeps every seat to "one API hit, then reused."
 */
async function getOrFetch(namespace, key, maxAgeMs, fetchFn) {
  const cached = read(namespace, key);
  if (!isStale(cached, maxAgeMs)) {
    return { data: cached.data, fromCache: true, ageDays: ageDays(cached) };
  }
  const fresh = await fetchFn();
  write(namespace, key, fresh);
  return { data: fresh, fromCache: false, ageDays: 0 };
}

module.exports = { read, write, isStale, ageDays, getOrFetch };
