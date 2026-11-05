import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(ROOT, '../slhts');
const CONTEXT = 'QuantumSmartWallet/SLH-DSA-SHA2-128s/v1';
const ALGORITHM = 'sha2';

class SafeError extends Error {}
function fail(message) { throw new SafeError(message); }

function localPath(input) {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) fail('Invalid file path.');
  const result = resolve(input);
  const child = relative(ROOT, result);
  if (!child || child === '..' || child.startsWith('../') || isAbsolute(child)) {
    fail('Files must be inside the demo directory.');
  }
  return result;
}

function decodeHex(input, length, label) {
  if (typeof input !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${length * 2}}$`).test(input)) {
    fail(`Invalid ${label} encoding or length.`);
  }
  return new Uint8Array(Buffer.from(input.slice(2), 'hex'));
}

async function loadWasm() {
  const api = await import(pathToFileURL(resolve(PACKAGE, 'dist/index.js')).href);
  const image = readFileSync(resolve(PACKAGE, 'pkg/rslh_bg.wasm'));
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/rslh_bg.wasm') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/wasm',
      'Content-Length': image.length,
      'Connection': 'close',
    }).end(image);
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    await api.init(new URL(`http://127.0.0.1:${server.address().port}/rslh_bg.wasm`));
  } finally {
    await new Promise((done) => server.close(done));
  }
  return api;
}

async function main() {
  const [command, keyInput, digestInput, signatureInput, ...extra] = process.argv.slice(2);
  if (extra.length || (command === 'keygen' ? digestInput !== undefined : command !== 'sign' || signatureInput === undefined)) {
    fail('Usage: keygen <key-file> | sign <key-file> <0x32-byte-digest> <signature-file>.');
  }
  const keyFile = localPath(keyInput);
  const signatureFile = command === 'sign' ? localPath(signatureInput) : undefined;
  if (signatureFile === keyFile) fail('Key and signature paths must differ.');
  const digest = command === 'sign' ? decodeHex(digestInput, 32, 'digest') : undefined;
  const api = await loadWasm();

  if (command === 'keygen') {
    const pair = api.generateKeyPair(ALGORITHM);
    try {
      const publicKey = `0x${api.toHex(pair.publicKey)}`;
      writeFileSync(keyFile, JSON.stringify({
        version: 1,
        algorithm: ALGORITHM,
        context: CONTEXT,
        publicKey,
        secretKey: `0x${api.toHex(pair.secretKey)}`,
      }) + '\n', { flag: 'wx', mode: 0o600 });
      process.stdout.write(JSON.stringify({ algorithm: ALGORITHM, publicKey, publicKeyBytes: pair.publicKey.length }) + '\n');
    } finally {
      pair.secretKey.fill(0);
    }
    return;
  }

  if ((statSync(keyFile).mode & 0o077) !== 0) fail('Key file permissions must be 0600.');
  const saved = JSON.parse(readFileSync(keyFile, 'utf8'));
  if (saved.version !== 1 || saved.algorithm !== ALGORITHM || saved.context !== CONTEXT) {
    fail('Key file algorithm, version or context mismatch.');
  }
  const secret = decodeHex(saved.secretKey, 64, 'private key');
  saved.secretKey = '';
  try {
    const publicBytes = api.publicKeyOf(secret);
    const publicKey = `0x${api.toHex(publicBytes)}`;
    if (publicKey !== saved.publicKey) fail('Key file public key mismatch.');
    const context = new TextEncoder().encode(CONTEXT);
    // Omit deterministic: the public WASM API uses hedged OS-backed randomness.
    const signature = api.sign(ALGORITHM, secret, digest, { context });
    if (signature.length !== 7856 || !api.verify(ALGORITHM, publicBytes, digest, signature, context)) {
      fail('WASM signature self-check failed.');
    }
    writeFileSync(signatureFile, signature, { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ algorithm: ALGORITHM, publicKey, signatureBytes: signature.length }) + '\n');
  } finally {
    secret.fill(0);
  }
}

main().catch((error) => {
  // Never render arbitrary exceptions or input data: they may contain key material.
  process.stderr.write((error instanceof SafeError ? error.message : 'WASM signer failed.') + '\n');
  process.exitCode = 1;
});
