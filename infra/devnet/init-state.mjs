#!/usr/bin/env node
// Offline, one-time seeding of a fresh named volume from the sealed snapshot.
import {createReadStream} from 'node:fs';
import {cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const chainId = 81411338;
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function regularJson(file) {
  if (!(await lstat(file)).isFile()) throw new Error('Expected a regular snapshot metadata file');
  return JSON.parse(await readFile(file, 'utf8'));
}
async function exists(file) {
  try {await lstat(file); return true;} catch (error) {if (error.code === 'ENOENT') return false; throw error;}
}
export async function initializeState(bundle, target, role) {
  if (!['execution', 'consensus'].includes(role)) throw new Error('Unknown snapshot role');
  const metadata = await regularJson(path.join(bundle, 'manifest.json'));
  if (metadata.formatVersion !== 2 || metadata.chainId !== chainId ||
      metadata.snapshot?.hezeActive !== true || metadata.snapshot.hezeForkEpoch !== 2 ||
      !Number.isInteger(metadata.snapshot.observedPostHezeAdvances) || metadata.snapshot.observedPostHezeAdvances < 2 ||
      !Number.isInteger(metadata.snapshot.consensusSlot) || metadata.snapshot.consensusSlot < 64 ||
      !Number.isInteger(metadata.snapshot.executionBlockNumber) || metadata.snapshot.executionBlockNumber < 1 ||
      !/^0x[0-9a-fA-F]{64}$/.test(metadata.snapshot.executionBlockHash || '')) {
    throw new Error('A mined, post-Heze version 2 snapshot is required');
  }
  const genesisHash = await sha256(path.join(bundle, 'genesis.json'));
  if (metadata.files['genesis.json'] !== genesisHash) throw new Error('Snapshot genesis checksum differs');
  const fingerprint = {chainId, genesisSha256: genesisHash, snapshotBlockHash: metadata.snapshot.executionBlockHash, role};
  const databasePointer = role === 'execution' ? `chain-${chainId}/CURRENT` : 'beacon/chain_db/CURRENT';
  async function requireDatabase(directory) {
    const pointer = path.join(directory, databasePointer);
    const stat = await lstat(pointer);
    if (!stat.isFile() || stat.size === 0) throw new Error('Retained database is missing; restore its backup');
  }
  const runtime = path.join(target, 'runtime');
  if (await exists(runtime)) {
    if (!(await lstat(runtime)).isDirectory()) throw new Error('Runtime data path is unsafe');
    const recorded = await regularJson(path.join(runtime, '.qsw-snapshot.json'));
    if (JSON.stringify(recorded) !== JSON.stringify(fingerprint)) throw new Error('Existing database belongs to another snapshot; preserve it');
    await requireDatabase(runtime);
    return {initialized: false, role, chainId};
  }
  await mkdir(target, {recursive: true, mode: 0o700});
  if ((await readdir(target)).length !== 0) throw new Error('Unmarked/nonempty data volume must be preserved; choose this genesis project namespace');
  const prefix = `snapshot/${role}/`;
  const source = path.join(bundle, 'snapshot', role);
  if (!(await lstat(source)).isDirectory()) throw new Error('Snapshot data directory is unsafe');
  await requireDatabase(source);
  const files = [];
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name);
      const stat = await lstat(file);
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) files.push(file);
      else throw new Error('Snapshot contains an unsafe filesystem entry');
    }
  }
  await walk(source);
  if (!files.length) throw new Error('Database snapshot is empty');
  const expectedFiles = Object.keys(metadata.files).filter(name => name.startsWith(prefix));
  if (files.length !== expectedFiles.length) throw new Error('Snapshot file inventory differs from the sealed manifest');
  for (const file of files) {
    const relative = path.relative(bundle, file).split(path.sep).join('/');
    if (metadata.files[relative] !== await sha256(file)) throw new Error('Database snapshot checksum differs');
  }
  const staging = path.join(target, `.qsw-seeding-${process.pid}`);
  try {
    await cp(source, staging, {recursive: true, force: false, errorOnExist: true});
    await writeFile(path.join(staging, '.qsw-snapshot.json'), JSON.stringify(fingerprint) + '\n', {mode: 0o600, flag: 'wx'});
    await rename(staging, runtime);
  } catch (error) {
    // Only remove the staging directory created by this invocation, never data.
    await rm(staging, {recursive: true, force: true});
    throw error;
  }
  return {initialized: true, role, chainId};
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [, , bundle, target, role] = process.argv;
    if (!bundle || !target || !role || process.argv.length !== 5) throw new Error('Expected bundle, target, and snapshot role');
    console.log(JSON.stringify(await initializeState(bundle, target, role)));
  } catch (error) {
    console.error(`Database initialization refused: ${error.message}`);
    process.exitCode = 1;
  }
}
