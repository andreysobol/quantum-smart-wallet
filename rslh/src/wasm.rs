//! WebAssembly bindings (cargo feature `wasm`), exported with `wasm-bindgen`.
//!
//! Keys and signatures are plain byte arrays (`Uint8Array` in JavaScript) in the
//! raw FIPS 205 layout: 64-byte private key `SK.seed || SK.prf || PK.seed || PK.root`,
//! 32-byte public key `PK.seed || PK.root`, 7,856-byte signature. The parameter
//! set is chosen by name: `"sha2"` (SLH-DSA-SHA2-128s) or `"shake"`
//! (SLH-DSA-SHAKE-128s). Errors are thrown as JavaScript `Error`s.
//!
//! The TypeScript wrapper and browser tests are in ../slhts.
//!
//! WARNING: research code; see the crate documentation.

use crate::{
    Error, ParameterSet, PublicKey, SecretKey, Sha2_128s, Shake128s, N, PK_BYTES, SIG_BYTES,
    SK_BYTES,
};
use wasm_bindgen::prelude::*;

#[derive(Clone, Copy)]
enum Alg {
    Sha2,
    Shake,
}

fn alg(name: &str) -> Result<Alg, JsError> {
    match name.to_ascii_lowercase().as_str() {
        "sha2" | "slh-dsa-sha2-128s" => Ok(Alg::Sha2),
        "shake" | "slh-dsa-shake-128s" => Ok(Alg::Shake),
        _ => Err(JsError::new(&format!(
            "unknown algorithm '{name}' (use 'sha2' or 'shake')"
        ))),
    }
}

fn err(e: Error) -> JsError {
    JsError::new(match e {
        Error::RandomnessUnavailable => "randomness unavailable",
        Error::ContextTooLong => "context longer than 255 bytes",
        Error::InvalidLength => "invalid length",
    })
}

fn fixed<const M: usize>(v: &[u8], what: &str) -> Result<[u8; M], JsError> {
    v.try_into()
        .map_err(|_| JsError::new(&format!("{what}: expected {M} bytes, got {}", v.len())))
}

/// Run `f` with the parameter set named by `name` as a type.
macro_rules! with_alg {
    ($name:expr, $p:ident => $body:expr) => {
        match alg($name)? {
            Alg::Sha2 => {
                type $p = Sha2_128s;
                $body
            }
            Alg::Shake => {
                type $p = Shake128s;
                $body
            }
        }
    };
}

/// Full algorithm name, e.g. `"SLH-DSA-SHA2-128s"`.
#[wasm_bindgen(js_name = algorithmName)]
pub fn algorithm_name(alg: &str) -> Result<String, JsError> {
    Ok(with_alg!(alg, P => P::NAME.to_string()))
}

/// Private key size in bytes (64).
#[wasm_bindgen(js_name = secretKeyBytes)]
pub fn secret_key_bytes() -> usize {
    SK_BYTES
}

/// Public key size in bytes (32).
#[wasm_bindgen(js_name = publicKeyBytes)]
pub fn public_key_bytes() -> usize {
    PK_BYTES
}

/// Signature size in bytes (7,856).
#[wasm_bindgen(js_name = signatureBytes)]
pub fn signature_bytes() -> usize {
    SIG_BYTES
}

/// Generate a private key from browser randomness (`crypto.getRandomValues`).
/// The public key is its last 32 bytes, see [`public_key`].
#[wasm_bindgen(js_name = generateSecretKey)]
pub fn generate_secret_key(alg: &str) -> Result<Vec<u8>, JsError> {
    with_alg!(alg, P => Ok(crate::generate_private_key_with::<P>().map_err(err)?.to_bytes().to_vec()))
}

/// Deterministic key generation from `SK.seed || SK.prf || PK.seed` (48 bytes).
/// Only for tests and known-answer vectors.
#[wasm_bindgen(js_name = secretKeyFromSeed)]
pub fn secret_key_from_seed(alg: &str, seed: &[u8]) -> Result<Vec<u8>, JsError> {
    if seed.len() != 3 * N {
        return Err(JsError::new(&format!(
            "seed: expected {} bytes, got {}",
            3 * N,
            seed.len()
        )));
    }
    let s = |i: usize| fixed::<N>(&seed[i * N..(i + 1) * N], "seed");
    with_alg!(alg, P => {
        let (sk, _) = crate::keygen_from_seeds_with::<P>(s(0)?, s(1)?, s(2)?);
        Ok(sk.to_bytes().to_vec())
    })
}

/// The 32-byte public key contained in a 64-byte private key.
#[wasm_bindgen(js_name = publicKey)]
pub fn public_key(secret_key: &[u8]) -> Result<Vec<u8>, JsError> {
    let sk: [u8; SK_BYTES] = fixed(secret_key, "private key")?;
    Ok(sk[2 * N..].to_vec())
}

/// Sign `message` with an optional `context` (at most 255 bytes).
/// Hedged with browser randomness, or deterministic when `deterministic` is true.
#[wasm_bindgen]
pub fn sign(
    alg: &str,
    secret_key: &[u8],
    message: &[u8],
    context: &[u8],
    deterministic: bool,
) -> Result<Vec<u8>, JsError> {
    let sk: [u8; SK_BYTES] = fixed(secret_key, "private key")?;
    with_alg!(alg, P => {
        let sk = SecretKey::<P>::from_bytes(sk);
        if deterministic {
            crate::sign_deterministic(message, context, &sk).map_err(err)
        } else {
            crate::sign(message, context, &sk).map_err(err)
        }
    })
}

/// Verify a signature; returns `false` for an invalid signature (including a
/// wrong length) and throws only for malformed keys or a too-long context.
#[wasm_bindgen]
pub fn verify(
    alg: &str,
    public_key: &[u8],
    message: &[u8],
    context: &[u8],
    signature: &[u8],
) -> Result<bool, JsError> {
    let pk: [u8; PK_BYTES] = fixed(public_key, "public key")?;
    with_alg!(alg, P => crate::verify(message, context, signature, &PublicKey::<P>::from_bytes(pk)).map_err(err))
}
