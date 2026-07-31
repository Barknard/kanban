/**
 * Keeps the service worker's cache name tied to the actual contents of the app shell.
 *
 * WHY THIS EXISTS: the cache name used to be a hand-written version string. Change
 * index.html, forget to bump it, and the service worker keeps serving the OLD page to
 * everyone who has already visited — the deploy is correct on the server and wrong in
 * every returning browser. That happened, and the fix ("remember to bump CACHE") is
 * exactly the kind of manual marker that rots.
 *
 * Now the cache name contains a hash of the shell files. Any change to them changes the
 * cache name, which changes sw.js itself, which is what makes the browser install a new
 * worker and drop the old caches.
 *
 *   node tools/sync-sw-version.mjs         # rewrite sw.js to match the shell
 *   node tools/sync-sw-version.mjs --check # exit 1 if out of sync (used by CI + tests)
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Everything the worker precaches, minus sw.js itself (which this rewrites). */
const SHELL_FILES = [
  "index.html",
  "manifest.json",
  "simple-kanban-logo.gif",
  "favicon.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png",
];

const TEXT = /\.(html|json|js|css|svg)$/i;

/**
 * Text files are normalised to LF before hashing.
 *
 * Git checks these out with CRLF on Windows and LF on Linux, so hashing raw bytes gives
 * a different fingerprint on a developer's machine than in CI — the check then fails on
 * CI for a file nobody touched. Binary assets are hashed as-is.
 */
function contentFor(file) {
  const bytes = readFileSync(join(root, file));
  return TEXT.test(file) ? bytes.toString("utf-8").replace(/\r\n/g, "\n") : bytes;
}

const hash = createHash("sha256");
for (const file of SHELL_FILES) hash.update(contentFor(file));
const fingerprint = hash.digest("hex").slice(0, 12);

const swPath = join(root, "sw.js");
const sw = readFileSync(swPath, "utf-8");

const CACHE_LINE = /^const CACHE = '([^']+)';$/m;
const current = sw.match(CACHE_LINE)?.[1];
if (!current) {
  console.error("Could not find the `const CACHE = '...'` line in sw.js");
  process.exit(2);
}

const expected = `simple-kanban-${fingerprint}`;

if (process.argv.includes("--check")) {
  if (current !== expected) {
    console.error(
      `sw.js cache name is stale.\n` +
        `  found:    ${current}\n` +
        `  expected: ${expected}\n\n` +
        `The app shell changed but the service worker did not, so returning visitors\n` +
        `would keep seeing the old page. Run: node tools/sync-sw-version.mjs`,
    );
    process.exit(1);
  }
  console.log(`sw.js is in sync (${current})`);
} else {
  if (current === expected) {
    console.log(`already in sync (${current})`);
  } else {
    writeFileSync(swPath, sw.replace(CACHE_LINE, `const CACHE = '${expected}';`), "utf-8");
    console.log(`${current} -> ${expected}`);
  }
}
