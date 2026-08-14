/**
 * Is this Node new enough to run King Gong? Run BEFORE `npm ci`.
 *
 *   node scripts/node-check.cjs
 *
 * ── Why this file exists ──
 *
 * The app stores everything in Node's built-in SQLite. If Node is too old, `npm ci` succeeds, the dev
 * server starts, the home page compiles — and then the first render throws, because the very first
 * thing it does is open the database. `DEPLOY.md` already warns that this is the worst failure shape:
 * everything looks fine until it doesn't, and the error names a module rather than a Node version.
 *
 * Nothing in the repo guarded against it. This does.
 *
 * ── Why CommonJS, and why no dependencies ──
 *
 * Its entire job is to run on the WRONG version of Node and still print something useful. So it uses
 * the module system that has worked since Node 0.x, and imports nothing — it has to run before
 * `npm ci` has installed anything, which also rules out `tsx` and therefore every other script here.
 *
 * ── Why it tests the capability, not just the number ──
 *
 * `package.json` used to declare `>=22.5.0`, which is where `node:sqlite` first appeared — but it was
 * behind `--experimental-sqlite` until 22.13.0, so 22.5 through 22.12 would have passed a version check
 * and still failed at runtime. Measured on this machine with nvm:
 *
 *     node 22.12.0  ->  require('node:sqlite') throws ERR_UNKNOWN_BUILTIN_MODULE
 *     node 22.13.0  ->  loads unflagged, DatabaseSync is a function
 *
 * A version comparison is a proxy for the thing we care about. So this asks Node directly and uses the
 * version only to write a better error message. That ordering is the point.
 */
'use strict';

var GREEN = '\x1b[32m';
var RED = '\x1b[31m';
var DIM = '\x1b[2m';
var BOLD = '\x1b[1m';
var OFF = '\x1b[0m';
var colour = process.stdout.isTTY && !process.env.NO_COLOR;
function paint(code, s) {
  return colour ? code + s + OFF : s;
}

/** The floor we can justify, and the reason, kept together so neither drifts. */
var FLOOR = '22.13.0';
var REASON = 'node:sqlite is only available without a flag from 22.13.0';

function parts(v) {
  var m = String(v).replace(/^v/, '').split('.');
  return [parseInt(m[0], 10) || 0, parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0];
}

function atLeast(actual, wanted) {
  var a = parts(actual);
  var b = parts(wanted);
  for (var i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

var current = process.versions.node;

/** The authoritative test: can this Node actually do the two things the app needs? */
var capabilities = [];

try {
  /*
    `require`, not `import`, and eslint has to be told so. This whole file is CommonJS on purpose: it
    runs before `npm ci`, on whatever Node the machine happens to have, to explain why that Node will
    not work. An ESM import would be one more thing that could fail before the message got printed.
  */
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  var sqlite = require('node:sqlite');
  capabilities.push({
    name: 'node:sqlite (DatabaseSync)',
    ok: typeof sqlite.DatabaseSync === 'function',
    detail: typeof sqlite.DatabaseSync === 'function' ? '' : 'module loaded but DatabaseSync missing',
  });
} catch (err) {
  capabilities.push({
    name: 'node:sqlite (DatabaseSync)',
    ok: false,
    detail: (err && err.code) || (err && err.message) || 'unavailable',
  });
}

capabilities.push({
  name: 'process.loadEnvFile',
  ok: typeof process.loadEnvFile === 'function',
  detail: typeof process.loadEnvFile === 'function' ? '' : 'needed to read .env.local in scripts',
});

var failed = capabilities.filter(function (cap) {
  return !cap.ok;
});

console.log('');
console.log(paint(BOLD, 'Node check') + '  ' + paint(DIM, 'node ' + current));
capabilities.forEach(function (cap) {
  var glyph = cap.ok ? paint(GREEN, '✓') : paint(RED, '✗');
  console.log('  ' + glyph + ' ' + cap.name + (cap.detail ? '  ' + paint(DIM, cap.detail) : ''));
});

if (failed.length === 0) {
  console.log('');
  process.exit(0);
}

/*
  Fail with the fix, not just the diagnosis.

  Ordered no-sudo-first, and nvm is listed before Homebrew on purpose: brew is absent on plenty of
  Macs (including the one this was developed on, where Node came from the official tarball into
  ~/.local), so leading with it sends people to install a package manager to install a runtime.
*/
console.log('');
console.log(
  '  ' +
    paint(RED, 'This Node cannot run King Gong.') +
    ' Need ' +
    paint(BOLD, '>=' + FLOOR) +
    ', found ' +
    paint(BOLD, current) +
    '.',
);
console.log('  ' + paint(DIM, REASON + '.'));
if (atLeast(current, '22.5.0') && !atLeast(current, FLOOR)) {
  console.log(
    '  ' +
      paint(DIM, 'Note: ' + current + ' has node:sqlite behind --experimental-sqlite, which is why a') +
      '\n  ' +
      paint(DIM, 'version check against 22.5.0 would have let this through.'),
  );
}
console.log('');
console.log('  ' + paint(BOLD, 'Pick whichever you have:'));
console.log('    ' + paint(DIM, '# nvm, no admin rights needed - honours the .nvmrc in this repo'));
console.log('    nvm install && nvm use');
console.log('    ' + paint(DIM, '# Homebrew'));
console.log('    brew install node@24 && brew link --overwrite node@24');
console.log('    ' + paint(DIM, '# no package manager: the official tarball, into ~/.local'));
console.log('    ' + paint(DIM, 'see https://nodejs.org/en/download - pick macOS arm64, then:'));
console.log('    tar -xJf node-*.tar.xz -C ~/.local --strip-components=1');
console.log('');
console.log('  ' + paint(DIM, 'Then re-run:  ./setup.sh'));
console.log('');
process.exit(1);
