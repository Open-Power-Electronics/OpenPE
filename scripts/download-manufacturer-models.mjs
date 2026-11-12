import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../resources/example-catalog/footprints/emc-flyback/manifest.json' with { type: 'json' };
import { prepareEmcCmbModel, emcCmbSource } from './prepare-emc-cmb-model.mjs';

const root = fileURLToPath(
  new URL('../resources/example-catalog/footprints/emc-flyback/', import.meta.url),
);
const limit = 30_000_000;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function approvedHosts(entry) {
  const hosts = entry.approvedHosts;
  const origin = new URL(entry.sourceUrl).hostname;
  if (
    !Array.isArray(hosts) ||
    hosts.length < 1 ||
    hosts.some((host) => typeof host !== 'string' || !host || host !== host.toLowerCase()) ||
    !hosts.includes(origin)
  )
    throw new Error(`Manufacturer model ${entry.file} has no approved download hosts.`);
  return hosts;
}

async function fetchPinned(url, hosts, signal) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const target = new URL(current);
    if (
      target.protocol !== 'https:' ||
      target.port ||
      target.username ||
      target.password ||
      !hosts.includes(target.hostname)
    )
      throw new Error(
        `Pinned manufacturer download refused ${target.hostname} for ${url}. Approved hosts: ${hosts.join(', ')}.`,
      );
    const response = await fetch(current, { redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error(`Pinned manufacturer download redirect from ${current} has no location.`);
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Pinned manufacturer download failed (${response.status}) for ${current}.`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error(`Pinned manufacturer download exceeded ${limit} bytes.`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error(`Pinned manufacturer download exceeded the redirect limit for ${url}.`);
}

async function existing(file) {
  const info = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Manufacturer model ${file} must be a regular file.`);
  return readFile(file);
}

async function publish(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

const notices = new Map(manifest.licenses.map((entry) => [entry.file, entry.sha256]));
for (const entry of Object.values(manifest.models)) {
  const expected = notices.get(entry.license);
  if (!expected) throw new Error(`Manufacturer model ${entry.file} has no pinned license notice.`);
  const notice = await readFile(path.join(root, entry.license));
  if (digest(notice) !== expected)
    throw new Error(`Manufacturer license notice ${entry.license} failed its pinned checksum.`);
}
function assertStep(bytes, file) {
  if (
    !bytes.subarray(0, 100).toString('latin1').trimStart().startsWith('ISO-10303-21;') ||
    !bytes.subarray(-40).toString('latin1').includes('END-ISO-10303-21;')
  )
    throw new Error(
      `Official download for ${file} did not return a STEP file (${bytes.length} bytes).`,
    );
}
const signal = AbortSignal.timeout(120_000);
const failures = [];
for (const entry of Object.values(manifest.models)) {
  try {
    const file = path.join(root, entry.file);
    const hosts = approvedHosts(entry);
    const present = await existing(file);
    if (present) {
      if (digest(present) !== entry.sha256 || present.length !== entry.size)
        throw new Error(
          `Manufacturer model ${entry.file} differs from the pinned checksum. The existing file was preserved.`,
        );
      console.log(`${entry.file}: pinned bytes already present.`);
      continue;
    }
    const downloaded = await fetchPinned(entry.sourceUrl, hosts, signal);
    let bytes = downloaded;
    if (entry.sourceSha256) {
      assertStep(downloaded, `${entry.file} source`);
      if (digest(downloaded) !== entry.sourceSha256)
        throw new Error(`Manufacturer source ${entry.file} failed its pinned source checksum.`);
      if (
        entry.sourceCommit !== emcCmbSource.commit ||
        entry.sourceSha256 !== emcCmbSource.sha256
      )
        throw new Error(`Manufacturer source ${entry.file} is not the pinned CMB model.`);
      bytes = prepareEmcCmbModel(downloaded);
    }
    assertStep(bytes, entry.file);
    if (digest(bytes) !== entry.sha256 || bytes.length !== entry.size)
      throw new Error(`Manufacturer model ${entry.file} failed its pinned checksum.`);
    await publish(file, bytes);
    console.log(`${entry.file}: downloaded and verified ${bytes.length} bytes.`);
  } catch (error) {
    failures.push(error.message);
  }
}
if (failures.length) throw new Error(failures.join('\n'));
