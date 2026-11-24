import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = new URL('./', import.meta.url);
const output = new URL('./dist/', here);
const release = JSON.parse(
  await readFile(new URL('release.json', here), 'utf8'),
);
const tag = `v${release.version}`;
const releaseBase = 'https://github.com/Barbacoa08/scratchtree/releases';
const archPrefix = `${releaseBase}/download/${tag}/scratchtree-preview-${release.version}-`;
if (
  release.downloadUrl !==
    `${releaseBase}/download/${tag}/Scratchtree_${release.version}_aarch64.dmg` ||
  typeof release.archDownloadUrl !== 'string' ||
  !release.archDownloadUrl.startsWith(archPrefix) ||
  !/^[1-9]\d*-x86_64\.pkg\.tar\.zst$/.test(
    release.archDownloadUrl.slice(archPrefix.length),
  ) ||
  release.releaseUrl !== `${releaseBase}/tag/${tag}` ||
  !/^macOS [\d.]+ on Apple Silicon Macs$/.test(release.testedOn)
)
  throw new Error(
    'Review both release assets and the observed Mac environment before building the landing page.',
  );
const macUpdateSource = await readFile(
  new URL('mac-update.json', here),
  'utf8',
);
const macUpdate = JSON.parse(macUpdateSource);
const macTarget = macUpdate?.platforms?.['darwin-aarch64'];
const macVersion = macUpdate?.version;
if (
  Buffer.byteLength(macUpdateSource) > 64 * 1024 ||
  typeof macVersion !== 'string' ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(macVersion) ||
  Object.keys(macUpdate).some(
    (key) => !['version', 'notes', 'platforms'].includes(key),
  ) ||
  (macUpdate.notes != null &&
    (typeof macUpdate.notes !== 'string' ||
      Buffer.byteLength(macUpdate.notes) > 8 * 1024 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(
        macUpdate.notes,
      ))) ||
  macTarget?.url !==
    `${releaseBase}/download/v${macVersion}/Scratchtree-${macVersion}-aarch64.app.tar.gz` ||
  Object.keys(macUpdate.platforms).length !== 1 ||
  Object.keys(macTarget).length !== 2 ||
  typeof macTarget.signature !== 'string' ||
  !/^[a-zA-Z0-9+/]{1,4096}={0,2}$/.test(macTarget.signature) ||
  macTarget.signature.length > 4096
)
  throw new Error(
    'Review the macOS update manifest before publishing the site.',
  );
let html = await readFile(new URL('index.html', here), 'utf8');
for (const [key, value] of Object.entries(release))
  html = html.replaceAll(`{{${key}}}`, String(value));
if (html.includes('{{')) throw new Error('Unresolved landing-page content.');
await rm(output, { recursive: true, force: true });
await mkdir(new URL('assets/', output), { recursive: true });
await mkdir(new URL('releases/', output));
await writeFile(new URL('releases/mac.json', output), macUpdateSource);
await writeFile(new URL('index.html', output), html);
await cp(new URL('site.css', here), new URL('site.css', output));
await cp(
  fileURLToPath(import.meta.resolve('@barbajoe/css-lib')),
  new URL('barbajoe.css', output),
);
// Copy the original PNG payloads; no resampling or new artwork is introduced.
const icns = await readFile(new URL('../src-tauri/icons/icon.icns', here));
if (
  icns.toString('ascii', 0, 4) !== 'icns' ||
  icns.readUInt32BE(4) !== icns.length
)
  throw new Error('Invalid application icon container.');
const slots = new Map([
  ['icp4', 16],
  ['icp5', 32],
  ['ic12', 64],
  ['ic09', 512],
]);
for (let offset = 8; offset < icns.length;) {
  if (offset + 8 > icns.length) throw new Error('Truncated icon entry.');
  const type = icns.toString('ascii', offset, offset + 4);
  const length = icns.readUInt32BE(offset + 4);
  if (length < 8 || offset + length > icns.length)
    throw new Error('Invalid icon entry.');
  const size = slots.get(type);
  if (size) {
    const png = icns.subarray(offset + 8, offset + length);
    if (
      png.length < 24 ||
      png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      png.readUInt32BE(16) !== size ||
      png.readUInt32BE(20) !== size
    )
      throw new Error(`Expected a ${size}px PNG icon.`);
    await writeFile(new URL(`assets/icon-${size}.png`, output), png);
    slots.delete(type);
  }
  offset += length;
}
if (slots.size) throw new Error('Missing a required application icon size.');
await cp(
  new URL('../docs/media/workspace-overview.png', here),
  new URL('assets/workspace-overview.png', output),
);
console.log(`Built landing page for ${tag} at ${fileURLToPath(output)}`);
