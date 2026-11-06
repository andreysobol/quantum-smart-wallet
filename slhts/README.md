## slhts

Rust code compiled to WebAssembly, with a TypeScript API.

### Build

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked 

npm ci
npm run build
```

### Use from TypeScript

```ts
import { init, generateKeyPair, sign, verify } from "slhts";

await init();                                   // load rslh_bg.wasm once
const kp = generateKeyPair("sha2");             // or "shake"
const msg = new TextEncoder().encode("hello");
const ctx = new TextEncoder().encode("app");

const sig = sign("sha2", kp.secretKey, msg, { context: ctx });   // 7,856 bytes, takes ~1–3 s
verify("sha2", kp.publicKey, msg, sig, ctx);                     // true
```

### Test in a headless browser

```bash
cargo build --release --manifest-path ../rslh/Cargo.toml 
npx playwright install --with-deps chromium
npm test
```

The Playwright tests load `test/index.html` in headless Chromium, call the TypeScript API, and check:
round trips for both parameter sets, rejection of a modified message / context / signature,
byte-identical deterministic signatures and keys versus the native CLI, and that the CLI verifies
a hedged signature made in the browser.

## SLH-DSA-SHA2-128s

[FIPS 205: Stateless Hash-Based Digital Signature Standard](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.205.pdf)

NIST’s FIPS 205 defines SLH-DSA, a stateless, hash-based digital signature algorithm derived from SPHINCS+. Its SLH-DSA-SHA2-128s variant uses SHA-256 and prioritizes smaller signatures. The standard specifies key generation, signing, and verification for authenticating data with resistance to quantum computing attacks.
## rslh — SLH-DSA

Rust implementation of SLH-DSA-SHA2-128s and SLH-DSA-SHAKE-128s with a small CLI.
