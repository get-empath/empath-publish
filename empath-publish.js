#!/usr/bin/env node
/**
 * empath-publish: adds a build to a Team Builds build list (see
 * build-distribution-spec.md in the Empath repo). Runs in the customer's CI
 * and talks to nothing but the customer's own server. No dependencies, no
 * telemetry, no Empath account.
 *
 * It doesn't upload anything itself. It reads the current build list, adds
 * the new build, and writes a folder for CI's existing upload step to copy
 * to storage:
 *
 *   <out>/empath-builds.json
 *   <out>/builds/<platform>/<version>-<build>-<sha>.app.zip | .apk
 *
 *   empath-publish publish --out site --file Shop.app --platform ios \
 *     --version 4.3.0 --build 912 --channel beta \
 *     [--from https://builds.acme.com/shop/empath-builds.json] \
 *     [--app-name "Acme Shop" --app-id com.acme.shop] \
 *     [--notes "…"] [--commit $GITHUB_SHA] [--keep 20]
 *
 *   empath-publish promote --out site --build 912 --from-channel beta \
 *     --to-channel production [--version 4.3.0] [--from <list>]
 *
 * --from is the published build list (an https address or a file). Without
 * it, <out>/empath-builds.json is used if it exists. A token for reading it
 * goes in the EMPATH_BUILDS_TOKEN environment variable, so it stays out of
 * CI logs.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MANIFEST_NAME = 'empath-builds.json';
const PLATFORMS = ['ios', 'android'];
const CHANNEL_PATTERN = /^[a-z0-9-]+$/;
const DEFAULT_KEEP = 20;

const OPTIONS = {
  publish: ['out', 'file', 'platform', 'version', 'build', 'channel', 'from', 'app-name', 'app-id', 'notes', 'commit', 'keep'],
  promote: ['out', 'build', 'version', 'from-channel', 'to-channel', 'from', 'keep']
};

class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!OPTIONS[command]) {
    throw new UsageError('Usage: empath-publish publish|promote --out <folder> … (see the README)');
  }
  const args = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, '');
    if (!OPTIONS[command].includes(key) || rest[i + 1] === undefined) {
      throw new UsageError(`Unknown option or missing value: ${rest[i]}`);
    }
    // Empty values come from optional GitHub Action inputs left blank
    if (rest[i + 1] !== '') args[key] = rest[i + 1];
  }
  const required = command === 'publish'
    ? ['out', 'file', 'platform', 'version', 'channel']
    : ['out', 'build', 'from-channel', 'to-channel'];
  for (const key of required) {
    if (!args[key]) throw new UsageError(`--${key} is required.`);
  }
  for (const key of ['channel', 'from-channel', 'to-channel']) {
    if (args[key] && !CHANNEL_PATTERN.test(args[key])) {
      throw new UsageError(`--${key} must be lowercase letters, numbers and dashes, like "beta".`);
    }
  }
  if (args.platform && !PLATFORMS.includes(args.platform)) {
    throw new UsageError('--platform must be ios or android.');
  }
  args.keep = args.keep === undefined ? DEFAULT_KEEP : Number(args.keep);
  if (!Number.isInteger(args.keep) || args.keep < 1) {
    throw new UsageError('--keep must be a whole number of 1 or more.');
  }
  return { command, args };
}

/**
 * The current build list: from --from, else the one already in --out, else
 * null for a first publish. A list that exists but can't be read is an error,
 * never a fresh start, so a network blip can't wipe the build history.
 */
async function readCurrent({ from, out, token, fetchImpl = fetch }) {
  if (from && /^https?:\/\//.test(from)) {
    const response = await fetchImpl(from, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Cache-Control': 'no-cache' }
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Couldn't read the current build list at ${from} (HTTP ${response.status}).`);
    return parseManifest(await response.text(), from);
  }
  const file = from || path.join(out, MANIFEST_NAME);
  if (!fs.existsSync(file)) {
    if (from) throw new Error(`There's no build list at ${from}.`);
    return null;
  }
  return parseManifest(fs.readFileSync(file, 'utf8'), file);
}

function parseManifest(text, where) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`The build list at ${where} isn't valid JSON.`);
  }
  if (!data || data.schema !== 1 || typeof data.channels !== 'object' || Array.isArray(data.channels)) {
    throw new Error(`The build list at ${where} isn't a schema 1 build list.`);
  }
  return data;
}

// An .app folder is zipped the way Empath expects; a ready zip or .apk is used as is
function packageFile(file, platform, workDir) {
  if (!fs.existsSync(file)) throw new Error(`There's no file at ${file}.`);
  const isDir = fs.statSync(file).isDirectory();
  if (platform === 'android') {
    if (isDir || !file.endsWith('.apk')) throw new Error('Android builds must be an .apk file.');
    return { source: file, ext: '.apk' };
  }
  if (!isDir) {
    if (!file.endsWith('.zip')) throw new Error('iOS builds must be an .app folder or a zip of one.');
    return { source: file, ext: '.app.zip' };
  }
  if (!file.replace(/\/+$/, '').endsWith('.app')) throw new Error('iOS builds must be an .app folder or a zip of one.');
  const zip = path.join(workDir, 'build.app.zip');
  if (process.platform === 'darwin') {
    // ditto keeps the bundle's symlinks and permissions intact
    execFileSync('ditto', ['-c', '-k', '--keepParent', file, zip]);
  } else {
    execFileSync('zip', ['-qry', zip, path.basename(file)], { cwd: path.dirname(path.resolve(file)) });
  }
  return { source: zip, ext: '.app.zip' };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Newest first, the same build only once, at most `keep`
function addToChannel(manifest, channel, entry, keep) {
  const list = (manifest.channels[channel] || []).filter((item) => item.sha256 !== entry.sha256);
  manifest.channels[channel] = [entry, ...list].slice(0, keep);
}

function writeManifest(out, manifest) {
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, MANIFEST_NAME);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

async function publish(args, { token, fetchImpl, now = new Date() } = {}) {
  const current = await readCurrent({ from: args.from, out: args.out, token, fetchImpl });
  if (!current && !args['app-name']) {
    throw new UsageError('This is the first build in the list, so --app-name is required (and --app-id is recommended).');
  }
  const manifest = current || { schema: 1, app: {}, channels: {} };
  if (args['app-name']) manifest.app = { ...manifest.app, name: args['app-name'] };
  if (args['app-id']) manifest.app = { ...manifest.app, id: args['app-id'] };

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empath-publish-'));
  try {
    const { source, ext } = packageFile(args.file, args.platform, workDir);
    const checksum = sha256(source);
    const safe = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, '_');
    const relative = `builds/${args.platform}/${safe(args.version)}-${safe(args.build || '0')}-${checksum.slice(0, 8)}${ext}`;
    fs.mkdirSync(path.join(args.out, path.dirname(relative)), { recursive: true });
    fs.copyFileSync(source, path.join(args.out, relative));

    const entry = {
      version: args.version,
      ...(args.build ? { build: args.build } : {}),
      platform: args.platform,
      file: relative,
      sha256: checksum,
      size: fs.statSync(source).size,
      created: now.toISOString(),
      ...(args.commit ? { commit: args.commit } : {}),
      ...(args.notes ? { notes: args.notes } : {})
    };
    addToChannel(manifest, args.channel, entry, args.keep);
    const file = writeManifest(args.out, manifest);
    return { manifestPath: file, buildPath: path.join(args.out, relative), entry };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function promote(args, { token, fetchImpl, now = new Date() } = {}) {
  const manifest = await readCurrent({ from: args.from, out: args.out, token, fetchImpl });
  if (!manifest) throw new Error('There is no build list to promote from.');
  const found = (manifest.channels[args['from-channel']] || []).find((item) =>
    String(item.build) === args.build && (!args.version || item.version === args.version));
  if (!found) {
    throw new Error(`Build ${args.build} isn't in the ${args['from-channel']} channel.`);
  }
  // Same file and checksum, so nothing is uploaded again
  const entry = { ...found, created: now.toISOString() };
  addToChannel(manifest, args['to-channel'], entry, args.keep);
  return { manifestPath: writeManifest(args.out, manifest), entry };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const { command, args } = parseArgs(argv);
  const options = { token: env.EMPATH_BUILDS_TOKEN || null };
  const result = command === 'publish' ? await publish(args, options) : await promote(args, options);
  const where = args['to-channel'] || args.channel;
  console.log(`Added ${result.entry.version}${result.entry.build ? ` (${result.entry.build})` : ''} to ${where}.`);
  console.log(`Upload everything in ${args.out}/ to the folder that holds ${MANIFEST_NAME}.`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`empath-publish: ${error.message}`);
    process.exit(error instanceof UsageError ? 2 : 1);
  });
}

module.exports = { main, parseArgs, publish, promote, readCurrent, MANIFEST_NAME };
