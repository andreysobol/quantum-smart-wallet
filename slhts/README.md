# slhts

`rslh` (FIPS 205 SLH-DSA-SHA2-128s / SLH-DSA-SHAKE-128s) compiled to WebAssembly, with a TypeScript API.

> ⚠️ Research/educational code — not audited. Do not use it to protect real funds.

## Build

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked   # must match wasm-bindgen in ../rslh/Cargo.lock

npm ci
npm run build        # ./build.sh (Rust -> pkg/) + tsc (src/ -> dist/)
```

The Rust bindings live in `../rslh/src/wasm.rs` behind the optional cargo feature `wasm`; the native `rslh` CLI build is unchanged. `build.sh` compiles them to `pkg/` here.

## Use from TypeScript

```ts
import { init, generateKeyPair, sign, verify } from "slhts";

await init();                                   // load rslh_bg.wasm once
const kp = generateKeyPair("sha2");             // or "shake"
const msg = new TextEncoder().encode("hello");
const ctx = new TextEncoder().encode("app");

const sig = sign("sha2", kp.secretKey, msg, { context: ctx });   // 7,856 bytes, takes ~1–3 s
verify("sha2", kp.publicKey, msg, sig, ctx);                     // true
```

Keys and signatures are raw bytes in the FIPS 205 layout (64-byte private key, 32-byte public key),
the same bytes `rslh export` writes, so they can be moved between the browser, the CLI and OpenSSL.
`sign(..., { deterministic: true })` gives deterministic signatures; the default is hedged with
`crypto.getRandomValues`.

## Test in a headless browser

```bash
cargo build --release --manifest-path ../rslh/Cargo.toml   # native CLI, used for cross-checks
npx playwright install --with-deps chromium
npm test
```

The Playwright tests load `test/index.html` in headless Chromium, call the TypeScript API, and check:
round trips for both parameter sets, rejection of a modified message / context / signature,
byte-identical deterministic signatures and keys versus the native CLI, and that the CLI verifies
a hedged signature made in the browser.
