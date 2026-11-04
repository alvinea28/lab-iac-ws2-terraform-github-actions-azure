import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { ROOT } from './inputs.mjs';
import { canonicalJson, hash, parseStrictJson } from './plan-policy.mjs';

// No installation, scripts, credentials, subprocesses or network on import/build.
// Install with the lock, --omit=dev and --ignore-scripts BEFORE computing pins.
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const requiredDependencies = Object.freeze({ '@azure/identity': '4.14.1', '@azure/storage-blob': '12.34.0', express: '5.3.0' });
const forbidden = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git|\.azure|\.aws)(?:\/|$)|\.(?:pem|key|pfx|p12|p7b|tfstate(?:\..*)?|tfplan|enc)$/i;

function regular(file) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Package requires ordinary, non-linked files');
  assert.ok(stat.size <= 32 * 1024 * 1024, 'Package file exceeds its limit');
  return stat;
}

function readJson(file) {
  regular(file);
  return parseStrictJson(fs.readFileSync(file), 4 * 1024 * 1024);
}

function safeRelative(relative) {
  assert.ok(relative.length > 0 && relative.length <= 500 && !/[\\\x00-\x1f\x7f:]/.test(relative), 'Unsafe package path');
  assert.ok(relative.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe package path segment');
  assert.ok(!forbidden.test(relative), 'Credentials, keys, environment files, plans and state cannot be packaged');
  // Azure's LOCKED SDK has legitimate source directories named credentials.
  // Do not mistake those classes for a credential cache or private key file.
  if (!relative.startsWith('node_modules/')) assert.ok(!/(?:^|\/)(?:credentials?|secrets?)(?:\/|\.|$)/i.test(relative), 'Unreviewed application credential/secret path');
}

export function productionLock(app) {
  const manifest = readJson(path.join(app, 'package.json'));
  const lock = readJson(path.join(app, 'package-lock.json'));
  const installed = readJson(path.join(app, 'node_modules', '.package-lock.json'));
  assert.equal(canonicalJson(manifest.dependencies), canonicalJson(requiredDependencies), 'Use the exact supplied application dependencies');
  assert.equal(canonicalJson(lock.packages?.['']?.dependencies), canonicalJson(requiredDependencies), 'Application lock does not bind its manifest');
  assert.equal(lock.lockfileVersion, 3, 'Application needs its reviewed npm lockfile v3');
  assert.equal(installed.lockfileVersion, 3, 'Install the locked production application first');
  assert.equal(manifest.scripts?.start, 'node server.mjs', 'Package must retain the supplied npm start entry');
  const expected = new Map();
  for (const [relative, entry] of Object.entries(lock.packages ?? {})) {
    if (!relative || entry.dev === true || entry.devOptional === true) continue;
    safeRelative(relative);
    assert.match(relative, /^node_modules\/(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+(?:\/node_modules\/(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+)*$/);
    assert.ok(!entry.link && !entry.inBundle, 'Linked/bundled dependency layouts require a separately reviewed packager');
    assert.match(entry.integrity ?? '', /^sha512-[A-Za-z0-9+/]+={0,2}$/, 'Every production dependency needs lock integrity');
    assert.ok(entry.resolved?.startsWith('https://registry.npmjs.org/'), 'Only the reviewed npm registry lock is supported');
    const actual = installed.packages?.[relative];
    assert.ok(actual && actual.dev !== true && !actual.link, 'A locked production package is missing');
    for (const field of ['version', 'integrity', 'resolved']) assert.equal(actual[field], entry[field], 'Installed dependency differs from the production lock');
    const packageJson = readJson(path.join(app, relative, 'package.json'));
    assert.equal(packageJson.version, entry.version, 'Installed package version differs from its lock');
    expected.set(relative, entry);
  }
  assert.ok(expected.size > 0, 'Production dependencies are not installed');
  assert.equal(canonicalJson(Object.keys(installed.packages ?? {}).sort(compare)), canonicalJson([...expected.keys()].sort(compare)), 'Extraneous or development packages are installed');
  return { manifest, lock, expected };
}

export function buildPackage({ root = ROOT } = {}) {
  const app = path.join(path.resolve(root), 'app');
  assert.ok(!fs.lstatSync(app).isSymbolicLink(), 'Application root cannot be a symlink');
  const { expected } = productionLock(app);
  const entries = [];
  const folded = new Set();
  let total = 0;
  function walk(directory, relative = '') {
    assert.ok(!fs.lstatSync(directory).isSymbolicLink(), 'Package directories cannot be symlinks');
    for (const name of fs.readdirSync(directory).sort(compare)) {
      const item = relative ? `${relative}/${name}` : name;
      // npm's executable shims are not used by "node server.mjs". Do not follow
      // or package .bin (which contains normal npm-created symlinks on Linux).
      if (item === 'node_modules/.package-lock.json' || /(?:^|\/)node_modules\/\.bin$/.test(item)) continue;
      safeRelative(item);
      if (!relative) assert.ok(['server.mjs', 'package.json', 'package-lock.json', 'public', 'node_modules'].includes(name), 'Unreviewed application-root file');
      const full = path.join(directory, name);
      const stat = fs.lstatSync(full);
      assert.ok(!stat.isSymbolicLink(), 'Package cannot contain symlinks');
      if (item.startsWith('node_modules/')) {
        const parts = item.split('/');
        for (let index = 0; index < parts.length - 1; index += 1) {
          if (parts[index] !== 'node_modules') continue;
          const end = parts[index + 1]?.startsWith('@') ? index + 3 : index + 2;
          if (parts.length >= end) assert.ok(expected.has(parts.slice(0, end).join('/')), 'Untracked/development dependency in the installed tree');
        }
      }
      if (stat.isDirectory()) walk(full, item);
      else {
        assert.ok(!/^(?:credentials?|secrets?)(?:\.(?:json|txt|ya?ml|ini|config))?$/i.test(name), 'Credential/secret data files cannot be packaged');
        regular(full);
        const key = item.toLowerCase();
        assert.ok(!folded.has(key), 'Case-colliding ZIP entries are forbidden');
        folded.add(key);
        const bytes = fs.readFileSync(full);
        total += bytes.length;
        assert.ok(total <= MAX_SOURCE_BYTES && entries.length < 25_000, 'Application package exceeds its bounded source inventory');
        entries.push({ path: item, bytes, sha256: hash(bytes) });
      }
    }
  }
  walk(app);
  entries.sort((a, b) => compare(a.path, b.path));
  for (const required of ['server.mjs', 'package.json', 'package-lock.json', 'public/page.js', 'public/style.css']) {
    assert.ok(entries.some(entry => entry.path === required), 'Supplied application source is incomplete');
  }
  // fflate encodes local calendar fields in DOS time. A LOCAL 1980-01-01
  // produces identical DOS fields across time zones; a UTC Date would not.
  const fixedTime = new Date(1980, 0, 1, 0, 0, 0);
  const files = Object.create(null);
  for (const entry of entries) files[entry.path] = [entry.bytes, { mtime: fixedTime, os: 3, attrs: 0o100644 * 65536 }];
  const bytes = Buffer.from(zipSync(files, { level: 6, mem: 8 }));
  assert.ok(bytes.length > 0 && bytes.length <= MAX_PACKAGE_BYTES, 'Deployment ZIP exceeds its limit');
  return { bytes, sha256: hash(bytes), lockSha256: hash(fs.readFileSync(path.join(app, 'package-lock.json'))),
    files: entries.map(entry => ({ path: entry.path, size: entry.bytes.length, sha256: entry.sha256 })) };
}

export function writePackage({ root = ROOT } = {}) {
  const packed = buildPackage({ root });
  const directory = path.join(root, '.work', 'delivery', 'package');
  for (const part of [path.join(root, '.work'), path.join(root, '.work', 'delivery'), directory]) {
    if (fs.existsSync(part)) assert.ok(fs.lstatSync(part).isDirectory() && !fs.lstatSync(part).isSymbolicLink(), 'Unsafe package output directory');
    else fs.mkdirSync(part, { mode: 0o700 });
  }
  const output = path.join(directory, 'app.zip');
  fs.writeFileSync(output, packed.bytes, { mode: 0o600, flag: 'wx' });
  return { path: output, sha256: packed.sha256, files: packed.files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.deepEqual(process.argv.slice(2), ['build'], 'Use package-app.mjs build');
    const result = writePackage();
    console.log(JSON.stringify({ status: 'PACKAGED', sha256: result.sha256, files: result.files, azureAccessed: false }));
  } catch {
    console.error('Application packaging failed closed; check the production install and package allowlist.');
    process.exitCode = 1;
  }
}