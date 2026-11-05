//! NIST FIPS 205 (August 2024): SLH-DSA-SHA2-128s (default) and SLH-DSA-SHAKE-128s.
//!
//! Full *algorithmic* implementation for the two 128s standard parameter sets:
//! key generation, external/context pure signing and verification, deterministic
//! and randomized (hedged) signing, WOTS+, XMSS, FORS, hypertree, and encoding.
//!
//! The hash family is selected by the [`ParameterSet`] type parameter carried by
//! [`SecretKey`] and [`PublicKey`]. It defaults to [`Sha2_128s`] (SHA-256 based,
//! FIPS 205 Section 11.2.1); [`Shake128s`] (SHAKE256, Section 11.1) is available
//! through the `*_with::<Shake128s>` constructors.
//!
//! WARNING: educational/research code, not reviewed for constant time,
//! side-channel resistance, memory zeroization, or FIPS 140 validation.
//! Neither Rust implementation nor compiler output has been formally verified.
//! Do not deploy to protect real funds or production signing keys.

use core::marker::PhantomData;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use sha3::{
    digest::{ExtendableOutput, Update, XofReader},
    Shake256,
};

pub const N: usize = 16;
pub const H: usize = 63;
pub const D: usize = 7;
pub const H_PRIME: usize = H / D; // 9
pub const A: usize = 12;
pub const K: usize = 14;
pub const WOTS_LEN1: usize = 2 * N;
pub const WOTS_LEN2: usize = 3;
pub const WOTS_LEN: usize = WOTS_LEN1 + WOTS_LEN2;
pub const PK_BYTES: usize = 2 * N;
pub const SK_BYTES: usize = 4 * N;
pub const SIG_BYTES: usize = (1 + K * (1 + A) + H + D * WOTS_LEN) * N;
pub const DIGEST_BYTES: usize = 30; // ceil(168/8) + ceil(54/8) + ceil(9/8)

pub type Block = [u8; N];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    RandomnessUnavailable,
    ContextTooLong,
    InvalidLength,
}

/// Full (not SHA2-compressed) FIPS 205 address, Section 4.2 / Table 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
struct Address([u8; 32]);

impl Address {
    fn write_word(&mut self, offset: usize, x: u32) {
        self.0[offset..offset + 4].copy_from_slice(&x.to_be_bytes());
    }
    fn set_layer(&mut self, layer: u32) {
        self.write_word(0, layer);
    }
    fn set_tree(&mut self, tree: u64) {
        self.0[4..8].fill(0);
        self.0[8..16].copy_from_slice(&tree.to_be_bytes());
    }
    /// Also clears last 12 bytes as required when the type changes.
    fn set_type_and_clear(&mut self, ty: u32) {
        self.write_word(16, ty);
        self.0[20..32].fill(0);
    }
    fn set_keypair(&mut self, idx: u32) {
        self.write_word(20, idx);
    }
    fn set_chain(&mut self, idx: u32) {
        self.write_word(24, idx);
    }
    fn set_hash(&mut self, idx: u32) {
        self.write_word(28, idx);
    }
    fn set_height(&mut self, idx: u32) {
        self.write_word(24, idx);
    }
    fn set_index(&mut self, idx: u32) {
        self.write_word(28, idx);
    }
}

const WOTS_HASH: u32 = 0;
const WOTS_PK: u32 = 1;
const TREE: u32 = 2;
const FORS_TREE: u32 = 3;
const FORS_ROOTS: u32 = 4;
const WOTS_PRF: u32 = 5;
const FORS_PRF: u32 = 6;

mod sealed {
    use super::{Block, DIGEST_BYTES};
    /// Hash-family primitives of FIPS 205 Section 11. Not implementable outside
    /// this crate. Addresses are passed as the full 32-byte ADRS encoding.
    pub trait HashFamily {
        /// F, H and T_l (they differ only in input length for n = 16).
        fn thash(pk_seed: &Block, adrs: &[u8; 32], input: &[u8]) -> Block;
        fn prf(pk_seed: &Block, sk_seed: &Block, adrs: &[u8; 32]) -> Block;
        fn prf_msg(sk_prf: &Block, opt_rand: &Block, message: &[u8]) -> Block;
        fn h_msg(r: &Block, pk_seed: &Block, pk_root: &Block, message: &[u8])
            -> [u8; DIGEST_BYTES];
    }
}

/// A FIPS 205 128s parameter set (`n=16, h=63, d=7, a=12, k=14, w=16`),
/// distinguished only by its hash family. Sealed: implemented by
/// [`Sha2_128s`] and [`Shake128s`].
pub trait ParameterSet:
    sealed::HashFamily + Copy + Clone + core::fmt::Debug + PartialEq + Eq + Default + 'static
{
    /// The FIPS 205 parameter-set name, e.g. `"SLH-DSA-SHA2-128s"`.
    const NAME: &'static str;
}

/// SLH-DSA-SHA2-128s (FIPS 205 Section 11.2.1, security category 1). Default.
#[allow(non_camel_case_types)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Sha2_128s;

/// SLH-DSA-SHAKE-128s (FIPS 205 Section 11.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Shake128s;

/// The default parameter set used by the non-`_with` functions.
pub type DefaultParams = Sha2_128s;

impl ParameterSet for Sha2_128s {
    const NAME: &'static str = "SLH-DSA-SHA2-128s";
}
impl ParameterSet for Shake128s {
    const NAME: &'static str = "SLH-DSA-SHAKE-128s";
}

fn shake<const OUT: usize>(parts: &[&[u8]]) -> [u8; OUT] {
    let mut h = Shake256::default();
    for &part in parts {
        Update::update(&mut h, part);
    }
    let mut result = [0u8; OUT];
    h.finalize_xof().read(&mut result);
    result
}

// Section 11.1: F, H, Tlen, PRF share the SHAKE256(PK.seed || ADRS || M) form.
impl sealed::HashFamily for Shake128s {
    fn thash(pk_seed: &Block, adrs: &[u8; 32], input: &[u8]) -> Block {
        shake::<N>(&[pk_seed, adrs, input])
    }
    fn prf(pk_seed: &Block, sk_seed: &Block, adrs: &[u8; 32]) -> Block {
        shake::<N>(&[pk_seed, adrs, sk_seed])
    }
    fn prf_msg(sk_prf: &Block, opt_rand: &Block, message: &[u8]) -> Block {
        shake::<N>(&[sk_prf, opt_rand, message])
    }
    fn h_msg(r: &Block, pk_seed: &Block, pk_root: &Block, message: &[u8]) -> [u8; DIGEST_BYTES] {
        shake::<DIGEST_BYTES>(&[r, pk_seed, pk_root, message])
    }
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for &part in parts {
        Digest::update(&mut h, part);
    }
    h.finalize().into()
}

/// Section 11.2: 22-byte compressed address ADRSc =
/// ADRS[3] || ADRS[8:16] || ADRS[19] || ADRS[20:32].
fn compress_address(adrs: &[u8; 32]) -> [u8; 22] {
    let mut c = [0u8; 22];
    c[0] = adrs[3];
    c[1..9].copy_from_slice(&adrs[8..16]);
    c[9] = adrs[19];
    c[10..22].copy_from_slice(&adrs[20..32]);
    c
}

/// toByte(0, 64 - n): pads PK.seed to one full SHA-256 block.
const SHA256_SEED_PAD: [u8; 64 - N] = [0u8; 64 - N];

/// MGF1-SHA-256 (RFC 8017, B.2.1), output length `OUT`.
fn mgf1_sha256<const OUT: usize>(seed: &[u8]) -> [u8; OUT] {
    let mut out = [0u8; OUT];
    for (counter, chunk) in out.chunks_mut(32).enumerate() {
        let block = sha256(&[seed, &(counter as u32).to_be_bytes()]);
        chunk.copy_from_slice(&block[..chunk.len()]);
    }
    out
}

// Section 11.2.1 (security category 1): every function uses SHA-256.
impl sealed::HashFamily for Sha2_128s {
    fn thash(pk_seed: &Block, adrs: &[u8; 32], input: &[u8]) -> Block {
        let d = sha256(&[pk_seed, &SHA256_SEED_PAD, &compress_address(adrs), input]);
        block(&d[..N])
    }
    fn prf(pk_seed: &Block, sk_seed: &Block, adrs: &[u8; 32]) -> Block {
        let d = sha256(&[pk_seed, &SHA256_SEED_PAD, &compress_address(adrs), sk_seed]);
        block(&d[..N])
    }
    fn prf_msg(sk_prf: &Block, opt_rand: &Block, message: &[u8]) -> Block {
        let mut mac =
            <Hmac<Sha256> as Mac>::new_from_slice(sk_prf).expect("HMAC accepts any key length");
        Mac::update(&mut mac, opt_rand);
        Mac::update(&mut mac, message);
        block(&mac.finalize().into_bytes()[..N])
    }
    fn h_msg(r: &Block, pk_seed: &Block, pk_root: &Block, message: &[u8]) -> [u8; DIGEST_BYTES] {
        let inner = sha256(&[r, pk_seed, pk_root, message]);
        let mut seed = [0u8; 2 * N + 32];
        seed[..N].copy_from_slice(r);
        seed[N..2 * N].copy_from_slice(pk_seed);
        seed[2 * N..].copy_from_slice(&inner);
        mgf1_sha256::<DIGEST_BYTES>(&seed)
    }
}

fn thash<P: ParameterSet>(seed: &Block, adrs: &Address, input: &[u8]) -> Block {
    P::thash(seed, &adrs.0, input)
}
fn prf<P: ParameterSet>(seed: &Block, secret: &Block, adrs: &Address) -> Block {
    P::prf(seed, secret, &adrs.0)
}

/// Algorithm 5. The preconditions are `start + steps < 16`.
fn chain<P: ParameterSet>(
    mut value: Block,
    start: usize,
    steps: usize,
    pk_seed: &Block,
    mut adrs: Address,
) -> Block {
    debug_assert!(start + steps < 16);
    for j in start..start + steps {
        adrs.set_hash(j as u32);
        value = thash::<P>(pk_seed, &adrs, &value);
    }
    value
}

fn block(slice: &[u8]) -> Block {
    slice.try_into().expect("internal fixed-length block")
}

/// Algorithm 4: first `out_len` base-2^b digits, most significant first.
fn base_2b(input: &[u8], b: usize, out_len: usize) -> Vec<u32> {
    debug_assert!(b > 0 && b <= 16 && input.len() * 8 >= out_len * b);
    let mut out = Vec::with_capacity(out_len);
    let mut consumed = 0;
    for _ in 0..out_len {
        let mut value = 0u32;
        for _ in 0..b {
            let byte = input[consumed / 8];
            let bit = (byte >> (7 - (consumed % 8))) & 1;
            value = (value << 1) | u32::from(bit);
            consumed += 1;
        }
        out.push(value);
    }
    out
}

/// WOTS+ message digits plus the 12-bit big-endian checksum (Algorithms 7/8).
fn wots_digits(message: &Block) -> [usize; WOTS_LEN] {
    let mut digits = [0usize; WOTS_LEN];
    let mut checksum = 0u16;
    for i in 0..N {
        digits[2 * i] = (message[i] >> 4) as usize;
        digits[2 * i + 1] = (message[i] & 15) as usize;
        checksum += 15 - digits[2 * i] as u16;
        checksum += 15 - digits[2 * i + 1] as u16;
    }
    checksum <<= 4;
    let c = checksum.to_be_bytes();
    digits[WOTS_LEN1] = (c[0] >> 4) as usize;
    digits[WOTS_LEN1 + 1] = (c[0] & 15) as usize;
    digits[WOTS_LEN1 + 2] = (c[1] >> 4) as usize;
    digits
}

fn wots_sk<P: ParameterSet>(seed: &Block, pk_seed: &Block, original: Address, i: u32) -> Block {
    let mut a = original;
    a.set_type_and_clear(WOTS_PRF);
    a.set_keypair(u32::from_be_bytes(original.0[20..24].try_into().unwrap()));
    a.set_chain(i);
    prf::<P>(pk_seed, seed, &a)
}

/// Algorithm 6: compute compressed WOTS+ public key.
fn wots_pkgen<P: ParameterSet>(sk_seed: &Block, pk_seed: &Block, mut adrs: Address) -> Block {
    let original = adrs;
    let mut nodes = Vec::with_capacity(WOTS_LEN * N);
    for i in 0..WOTS_LEN {
        let sk = wots_sk::<P>(sk_seed, pk_seed, original, i as u32);
        adrs.set_chain(i as u32);
        nodes.extend_from_slice(&chain::<P>(sk, 0, 15, pk_seed, adrs));
    }
    let mut pkaddr = original;
    pkaddr.set_type_and_clear(WOTS_PK);
    pkaddr.set_keypair(u32::from_be_bytes(original.0[20..24].try_into().unwrap()));
    thash::<P>(pk_seed, &pkaddr, &nodes)
}

/// Algorithm 7. Caller supplies a WOTS_HASH address and the leaf index.
fn wots_sign<P: ParameterSet>(
    message: &Block,
    sk_seed: &Block,
    pk_seed: &Block,
    mut adrs: Address,
) -> Vec<u8> {
    let original = adrs;
    let digits = wots_digits(message);
    let mut sig = Vec::with_capacity(WOTS_LEN * N);
    for (i, digit) in digits.iter().enumerate() {
        let sk = wots_sk::<P>(sk_seed, pk_seed, original, i as u32);
        adrs.set_chain(i as u32);
        sig.extend_from_slice(&chain::<P>(sk, 0, *digit, pk_seed, adrs));
    }
    sig
}

/// Algorithm 8. Caller guarantees signature has WOTS_LEN*N bytes.
fn wots_pk_from_sig<P: ParameterSet>(
    sig: &[u8],
    message: &Block,
    pk_seed: &Block,
    mut adrs: Address,
) -> Block {
    let original = adrs;
    let digits = wots_digits(message);
    let mut nodes = Vec::with_capacity(WOTS_LEN * N);
    for (i, digit) in digits.iter().enumerate() {
        adrs.set_chain(i as u32);
        let sk = block(&sig[i * N..(i + 1) * N]);
        nodes.extend_from_slice(&chain::<P>(sk, *digit, 15 - *digit, pk_seed, adrs));
    }
    let mut pkaddr = original;
    pkaddr.set_type_and_clear(WOTS_PK);
    pkaddr.set_keypair(u32::from_be_bytes(original.0[20..24].try_into().unwrap()));
    thash::<P>(pk_seed, &pkaddr, &nodes)
}

/// Algorithm 9, indexed Merkle subtree with root height z, index i.
fn xmss_node<P: ParameterSet>(
    sk_seed: &Block,
    pk_seed: &Block,
    i: u32,
    z: usize,
    mut adrs: Address,
) -> Block {
    if z == 0 {
        adrs.set_type_and_clear(WOTS_HASH);
        adrs.set_keypair(i);
        wots_pkgen::<P>(sk_seed, pk_seed, adrs)
    } else {
        let l = xmss_node::<P>(sk_seed, pk_seed, 2 * i, z - 1, adrs);
        let r = xmss_node::<P>(sk_seed, pk_seed, 2 * i + 1, z - 1, adrs);
        adrs.set_type_and_clear(TREE);
        adrs.set_height(z as u32);
        adrs.set_index(i);
        let mut children = [0u8; 2 * N];
        children[..N].copy_from_slice(&l);
        children[N..].copy_from_slice(&r);
        thash::<P>(pk_seed, &adrs, &children)
    }
}

/// Algorithm 10, signature = WOTS+ signature || XMSS authentication path.
fn xmss_sign<P: ParameterSet>(
    message: &Block,
    sk_seed: &Block,
    pk_seed: &Block,
    leaf: u32,
    adrs: Address,
) -> Vec<u8> {
    let mut wots_addr = adrs;
    wots_addr.set_type_and_clear(WOTS_HASH);
    wots_addr.set_keypair(leaf);
    let mut sig = wots_sign::<P>(message, sk_seed, pk_seed, wots_addr);
    for j in 0..H_PRIME {
        let sibling = (leaf >> j) ^ 1;
        sig.extend_from_slice(&xmss_node::<P>(sk_seed, pk_seed, sibling, j, adrs));
    }
    sig
}

/// Algorithm 11, recover XMSS root from signature and selected leaf.
fn xmss_pk_from_sig<P: ParameterSet>(
    leaf: u32,
    sig: &[u8],
    message: &Block,
    pk_seed: &Block,
    mut adrs: Address,
) -> Block {
    let mut wots_addr = adrs;
    wots_addr.set_type_and_clear(WOTS_HASH);
    wots_addr.set_keypair(leaf);
    let mut node = wots_pk_from_sig::<P>(&sig[..WOTS_LEN * N], message, pk_seed, wots_addr);
    adrs.set_type_and_clear(TREE);
    for j in 0..H_PRIME {
        adrs.set_height((j + 1) as u32);
        adrs.set_index(leaf >> (j + 1));
        let sibling = &sig[(WOTS_LEN + j) * N..(WOTS_LEN + j + 1) * N];
        let mut children = [0u8; 2 * N];
        if ((leaf >> j) & 1) == 0 {
            children[..N].copy_from_slice(&node);
            children[N..].copy_from_slice(sibling);
        } else {
            children[..N].copy_from_slice(sibling);
            children[N..].copy_from_slice(&node);
        }
        node = thash::<P>(pk_seed, &adrs, &children);
    }
    node
}

/// Algorithm 12, signature of the complete D-layer hypertree.
fn ht_sign<P: ParameterSet>(
    message: &Block,
    sk_seed: &Block,
    pk_seed: &Block,
    mut tree: u64,
    mut leaf: u32,
) -> Vec<u8> {
    let mut adrs = Address::default();
    adrs.set_tree(tree);
    let first = xmss_sign::<P>(message, sk_seed, pk_seed, leaf, adrs);
    let mut sig = Vec::with_capacity((H + D * WOTS_LEN) * N);
    sig.extend_from_slice(&first);
    let mut root = xmss_pk_from_sig::<P>(leaf, &first, message, pk_seed, adrs);
    for layer in 1..D {
        leaf = (tree & ((1u64 << H_PRIME) - 1)) as u32;
        tree >>= H_PRIME;
        adrs.set_layer(layer as u32);
        adrs.set_tree(tree);
        let part = xmss_sign::<P>(&root, sk_seed, pk_seed, leaf, adrs);
        if layer + 1 < D {
            root = xmss_pk_from_sig::<P>(leaf, &part, &root, pk_seed, adrs);
        }
        sig.extend_from_slice(&part);
    }
    sig
}

/// Algorithm 13, root recovery and top-root comparison.
fn ht_verify<P: ParameterSet>(
    message: &Block,
    sig: &[u8],
    pk_seed: &Block,
    mut tree: u64,
    mut leaf: u32,
    pk_root: &Block,
) -> bool {
    let part_size = (WOTS_LEN + H_PRIME) * N;
    let mut adrs = Address::default();
    adrs.set_tree(tree);
    let mut node = xmss_pk_from_sig::<P>(leaf, &sig[..part_size], message, pk_seed, adrs);
    for layer in 1..D {
        leaf = (tree & ((1u64 << H_PRIME) - 1)) as u32;
        tree >>= H_PRIME;
        adrs.set_layer(layer as u32);
        adrs.set_tree(tree);
        node = xmss_pk_from_sig::<P>(
            leaf,
            &sig[layer * part_size..(layer + 1) * part_size],
            &node,
            pk_seed,
            adrs,
        );
    }
    node == *pk_root
}

/// Algorithm 14, FORS secret seed at one global leaf index.
fn fors_skgen<P: ParameterSet>(sk_seed: &Block, pk_seed: &Block, adrs: Address, idx: u32) -> Block {
    let keypair = u32::from_be_bytes(adrs.0[20..24].try_into().unwrap());
    let mut tmp = adrs;
    tmp.set_type_and_clear(FORS_PRF);
    tmp.set_keypair(keypair);
    tmp.set_index(idx);
    prf::<P>(pk_seed, sk_seed, &tmp)
}

/// Algorithm 15, indexed FORS tree node (height z, node index i).
fn fors_node<P: ParameterSet>(
    sk_seed: &Block,
    pk_seed: &Block,
    i: u32,
    z: usize,
    mut adrs: Address,
) -> Block {
    if z == 0 {
        let sk = fors_skgen::<P>(sk_seed, pk_seed, adrs, i);
        adrs.set_height(0);
        adrs.set_index(i);
        thash::<P>(pk_seed, &adrs, &sk)
    } else {
        let l = fors_node::<P>(sk_seed, pk_seed, 2 * i, z - 1, adrs);
        let r = fors_node::<P>(sk_seed, pk_seed, 2 * i + 1, z - 1, adrs);
        adrs.set_height(z as u32);
        adrs.set_index(i);
        let mut children = [0u8; 2 * N];
        children[..N].copy_from_slice(&l);
        children[N..].copy_from_slice(&r);
        thash::<P>(pk_seed, &adrs, &children)
    }
}

/// Algorithm 16, FORS signature: K secret elements plus K*A auth nodes.
fn fors_sign<P: ParameterSet>(
    md: &[u8],
    sk_seed: &Block,
    pk_seed: &Block,
    adrs: Address,
) -> Vec<u8> {
    let indices = base_2b(md, A, K);
    let mut sig = Vec::with_capacity(K * (A + 1) * N);
    for (i, &idx) in indices.iter().enumerate() {
        let global = ((i as u32) << A) + idx;
        sig.extend_from_slice(&fors_skgen::<P>(sk_seed, pk_seed, adrs, global));
        for j in 0..A {
            let sibling = (idx >> j) ^ 1;
            let global_sibling = ((i as u32) << (A - j)) + sibling;
            sig.extend_from_slice(&fors_node::<P>(sk_seed, pk_seed, global_sibling, j, adrs));
        }
    }
    sig
}

/// Algorithm 17, FORS public key from signature.
fn fors_pk_from_sig<P: ParameterSet>(
    sig: &[u8],
    md: &[u8],
    pk_seed: &Block,
    mut adrs: Address,
) -> Block {
    let indices = base_2b(md, A, K);
    let mut roots = Vec::with_capacity(K * N);
    for (i, &idx) in indices.iter().enumerate() {
        let off = i * (A + 1) * N;
        adrs.set_height(0);
        adrs.set_index(((i as u32) << A) + idx);
        let mut node = thash::<P>(pk_seed, &adrs, &sig[off..off + N]);
        for j in 0..A {
            adrs.set_height((j + 1) as u32);
            adrs.set_index(((i as u32) << (A - j - 1)) + (idx >> (j + 1)));
            let sibling = &sig[off + (j + 1) * N..off + (j + 2) * N];
            let mut children = [0u8; 2 * N];
            if ((idx >> j) & 1) == 0 {
                children[..N].copy_from_slice(&node);
                children[N..].copy_from_slice(sibling);
            } else {
                children[..N].copy_from_slice(sibling);
                children[N..].copy_from_slice(&node);
            }
            node = thash::<P>(pk_seed, &adrs, &children);
        }
        roots.extend_from_slice(&node);
    }
    let keypair = u32::from_be_bytes(adrs.0[20..24].try_into().unwrap());
    adrs.set_type_and_clear(FORS_ROOTS);
    adrs.set_keypair(keypair);
    thash::<P>(pk_seed, &adrs, &roots)
}

fn digest_parts(digest: &[u8; DIGEST_BYTES]) -> (&[u8], u64, u32) {
    let md = &digest[..21];
    let mut tree = 0u64;
    for &b in &digest[21..28] {
        tree = (tree << 8) | u64::from(b);
    }
    tree &= (1u64 << (H - H_PRIME)) - 1; // 54 bits
    let leaf = u16::from_be_bytes([digest[28], digest[29]]) as u32;
    (md, tree, leaf & ((1u32 << H_PRIME) - 1))
}

/// Private key `SK.seed || SK.prf || PK.seed || PK.root`, tagged with its
/// parameter set. The byte layout is identical for SHA2 and SHAKE, but a key
/// is only meaningful for the parameter set it was generated under.
///
/// Because Rust does not use default type parameters for inference, write
/// `let sk: SecretKey = SecretKey::from_bytes(b)` (SHA2) or
/// `SecretKey::<Shake128s>::from_bytes(b)` when importing.
#[derive(PartialEq, Eq)]
pub struct SecretKey<P: ParameterSet = DefaultParams>([u8; SK_BYTES], PhantomData<P>);
/// Public key `PK.seed || PK.root`, tagged with its parameter set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicKey<P: ParameterSet = DefaultParams>([u8; PK_BYTES], PhantomData<P>);

impl<P: ParameterSet> SecretKey<P> {
    pub fn from_bytes(bytes: [u8; SK_BYTES]) -> Self {
        Self(bytes, PhantomData)
    }
    pub fn to_bytes(&self) -> [u8; SK_BYTES] {
        self.0
    }
    pub fn public_key(&self) -> PublicKey<P> {
        let mut bytes = [0u8; PK_BYTES];
        bytes.copy_from_slice(&self.0[2 * N..]);
        PublicKey(bytes, PhantomData)
    }
    /// Expensive: recompute the top hypertree root and check stored PK.root.
    pub fn has_valid_root(&self) -> bool {
        let mut adrs = Address::default();
        adrs.set_layer((D - 1) as u32);
        xmss_node::<P>(
            &block(&self.0[..N]),
            &block(&self.0[2 * N..3 * N]),
            0,
            H_PRIME,
            adrs,
        ) == block(&self.0[3 * N..4 * N])
    }
    /// FIPS 205 parameter-set name of this key.
    pub fn algorithm(&self) -> &'static str {
        P::NAME
    }
}
impl<P: ParameterSet> PublicKey<P> {
    pub fn from_bytes(bytes: [u8; PK_BYTES]) -> Self {
        Self(bytes, PhantomData)
    }
    pub fn to_bytes(&self) -> [u8; PK_BYTES] {
        self.0
    }
    /// FIPS 205 parameter-set name of this key.
    pub fn algorithm(&self) -> &'static str {
        P::NAME
    }
}

/// FIPS 205, Algorithm 18, for an explicit parameter set.
/// Each seed MUST be securely and independently generated in production.
pub fn keygen_from_seeds_with<P: ParameterSet>(
    sk_seed: Block,
    sk_prf: Block,
    pk_seed: Block,
) -> (SecretKey<P>, PublicKey<P>) {
    let mut adrs = Address::default();
    adrs.set_layer((D - 1) as u32);
    let pk_root = xmss_node::<P>(&sk_seed, &pk_seed, 0, H_PRIME, adrs);
    let mut private = [0u8; SK_BYTES];
    private[..N].copy_from_slice(&sk_seed);
    private[N..2 * N].copy_from_slice(&sk_prf);
    private[2 * N..3 * N].copy_from_slice(&pk_seed);
    private[3 * N..4 * N].copy_from_slice(&pk_root);
    let mut public = [0u8; PK_BYTES];
    public[..N].copy_from_slice(&pk_seed);
    public[N..].copy_from_slice(&pk_root);
    (
        SecretKey(private, PhantomData),
        PublicKey(public, PhantomData),
    )
}

/// FIPS 205, Algorithm 18, default parameter set (SLH-DSA-SHA2-128s).
pub fn keygen_from_seeds(sk_seed: Block, sk_prf: Block, pk_seed: Block) -> (SecretKey, PublicKey) {
    keygen_from_seeds_with::<DefaultParams>(sk_seed, sk_prf, pk_seed)
}

/// FIPS 205, Algorithm 21: OS-backed random key generation, explicit parameter set.
pub fn generate_keypair_with<P: ParameterSet>() -> Result<(SecretKey<P>, PublicKey<P>), Error> {
    let mut seeds = [0u8; 3 * N];
    getrandom::getrandom(&mut seeds).map_err(|_| Error::RandomnessUnavailable)?;
    Ok(keygen_from_seeds_with::<P>(
        block(&seeds[..N]),
        block(&seeds[N..2 * N]),
        block(&seeds[2 * N..3 * N]),
    ))
}

/// FIPS 205, Algorithm 21: OS-backed random key generation (SLH-DSA-SHA2-128s).
pub fn generate_keypair() -> Result<(SecretKey, PublicKey), Error> {
    generate_keypair_with::<DefaultParams>()
}

/// Create a fresh private key for an explicit parameter set.
pub fn generate_private_key_with<P: ParameterSet>() -> Result<SecretKey<P>, Error> {
    generate_keypair_with::<P>().map(|(sk, _)| sk)
}

/// Create a fresh SLH-DSA-SHA2-128s private key; derive its public key with
/// `SecretKey::public_key`.
pub fn generate_private_key() -> Result<SecretKey, Error> {
    generate_private_key_with::<DefaultParams>()
}

/// Derive the public key contained in a well-formed private key.
/// This reads the embedded public key; call `has_valid_root` if imported
/// untrusted private key material needs consistency checking.
pub fn derive_public_key<P: ParameterSet>(sk: &SecretKey<P>) -> PublicKey<P> {
    sk.public_key()
}

/// FIPS 205, Algorithm 19. Raw/internal signing, before context domain separation.
/// Hedged: Some(fresh uniformly random 16-byte value); deterministic: None.
pub fn sign_internal<P: ParameterSet>(
    message: &[u8],
    sk: &SecretKey<P>,
    additional_randomness: Option<Block>,
) -> Vec<u8> {
    let sk_seed = block(&sk.0[..N]);
    let sk_prf = block(&sk.0[N..2 * N]);
    let pk_seed = block(&sk.0[2 * N..3 * N]);
    let pk_root = block(&sk.0[3 * N..4 * N]);
    let opt_rand = additional_randomness.unwrap_or(pk_seed);
    let r = P::prf_msg(&sk_prf, &opt_rand, message);
    let digest = P::h_msg(&r, &pk_seed, &pk_root, message);
    let (md, tree, leaf) = digest_parts(&digest);
    let mut adrs = Address::default();
    adrs.set_tree(tree);
    adrs.set_type_and_clear(FORS_TREE);
    adrs.set_keypair(leaf);
    let fors_sig = fors_sign::<P>(md, &sk_seed, &pk_seed, adrs);
    let fors_pk = fors_pk_from_sig::<P>(&fors_sig, md, &pk_seed, adrs);
    let ht_sig = ht_sign::<P>(&fors_pk, &sk_seed, &pk_seed, tree, leaf);
    let mut signature = Vec::with_capacity(SIG_BYTES);
    signature.extend_from_slice(&r);
    signature.extend_from_slice(&fors_sig);
    signature.extend_from_slice(&ht_sig);
    debug_assert_eq!(signature.len(), SIG_BYTES);
    signature
}

/// FIPS 205, Algorithm 20. Raw/internal verifier; rejects incorrect lengths.
pub fn verify_internal<P: ParameterSet>(
    message: &[u8],
    signature: &[u8],
    pk: &PublicKey<P>,
) -> bool {
    if signature.len() != SIG_BYTES {
        return false;
    }
    let pk_seed = block(&pk.0[..N]);
    let pk_root = block(&pk.0[N..]);
    let r = block(&signature[..N]);
    let digest = P::h_msg(&r, &pk_seed, &pk_root, message);
    let (md, tree, leaf) = digest_parts(&digest);
    let mut adrs = Address::default();
    adrs.set_tree(tree);
    adrs.set_type_and_clear(FORS_TREE);
    adrs.set_keypair(leaf);
    let end_fors = N + K * (A + 1) * N;
    let fors_pk = fors_pk_from_sig::<P>(&signature[N..end_fors], md, &pk_seed, adrs);
    ht_verify::<P>(
        &fors_pk,
        &signature[end_fors..],
        &pk_seed,
        tree,
        leaf,
        &pk_root,
    )
}

fn frame(message: &[u8], context: &[u8]) -> Result<Vec<u8>, Error> {
    if context.len() > 255 {
        return Err(Error::ContextTooLong);
    }
    let mut m = Vec::with_capacity(2 + context.len() + message.len());
    m.push(0); // pure signing, rather than HashSLH-DSA prehash.
    m.push(context.len() as u8);
    m.extend_from_slice(context);
    m.extend_from_slice(message);
    Ok(m)
}

/// FIPS 205, Algorithm 22, pure deterministic variant (opt_rand = PK.seed).
pub fn sign_deterministic<P: ParameterSet>(
    message: &[u8],
    context: &[u8],
    sk: &SecretKey<P>,
) -> Result<Vec<u8>, Error> {
    Ok(sign_internal(&frame(message, context)?, sk, None))
}

/// FIPS 205, Algorithm 22, pure hedged variant with explicit random n-byte value.
pub fn sign_with_randomness<P: ParameterSet>(
    message: &[u8],
    context: &[u8],
    sk: &SecretKey<P>,
    randomness: Block,
) -> Result<Vec<u8>, Error> {
    Ok(sign_internal(
        &frame(message, context)?,
        sk,
        Some(randomness),
    ))
}

/// FIPS 205, Algorithm 22, default hedged variant using OS randomness.
pub fn sign<P: ParameterSet>(
    message: &[u8],
    context: &[u8],
    sk: &SecretKey<P>,
) -> Result<Vec<u8>, Error> {
    let framed = frame(message, context)?;
    let mut randomness = [0u8; N];
    getrandom::getrandom(&mut randomness).map_err(|_| Error::RandomnessUnavailable)?;
    Ok(sign_internal(&framed, sk, Some(randomness)))
}

/// FIPS 205, Algorithm 24, pure external verification with context.
/// Incorrect signature length => false; too-long context => Err.
pub fn verify<P: ParameterSet>(
    message: &[u8],
    context: &[u8],
    signature: &[u8],
    pk: &PublicKey<P>,
) -> Result<bool, Error> {
    Ok(verify_internal(&frame(message, context)?, signature, pk))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parameter_sizes() {
        assert_eq!(SIG_BYTES, 7856);
        assert_eq!(PK_BYTES, 32);
        assert_eq!(SK_BYTES, 64);
        assert_eq!(WOTS_LEN, 35);
        assert_eq!(DIGEST_BYTES, 30);
        assert_eq!(Sha2_128s::NAME, "SLH-DSA-SHA2-128s");
        assert_eq!(Shake128s::NAME, "SLH-DSA-SHAKE-128s");
    }
    #[test]
    fn shake_abc() {
        assert_eq!(
            shake::<32>(&[b"abc"]),
            [
                0x48, 0x33, 0x66, 0x60, 0x13, 0x60, 0xa8, 0x77, 0x1c, 0x68, 0x63, 0x08, 0x0c, 0xc4,
                0x11, 0x4d, 0x8d, 0xb4, 0x45, 0x30, 0xf8, 0xf1, 0xe1, 0xee, 0x4f, 0x94, 0xea, 0x37,
                0xe7, 0x8b, 0x57, 0x39,
            ]
        );
    }
    #[test]
    fn sha256_abc_and_compressed_address() {
        assert_eq!(
            sha256(&[b"abc"]),
            from_hex::<32>("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
        let mut full = [0u8; 32];
        for (i, b) in full.iter_mut().enumerate() {
            *b = i as u8;
        }
        let c = compress_address(&full);
        assert_eq!(c[0], 3);
        assert_eq!(&c[1..9], &full[8..16]);
        assert_eq!(c[9], 19);
        assert_eq!(&c[10..], &full[20..]);
    }
    #[test]
    fn address_type_clear_and_digest() {
        let mut addr = Address([0xaa; 32]);
        addr.set_type_and_clear(FORS_TREE);
        assert_eq!(&addr.0[16..20], &[0, 0, 0, 3]);
        assert_eq!(&addr.0[20..], &[0; 12]);
        addr.set_tree(0x102030405060708);
        assert_eq!(&addr.0[4..8], &[0, 0, 0, 0]);
        assert_eq!(&addr.0[8..16], &[1, 2, 3, 4, 5, 6, 7, 8]);
        let d = [0xff; DIGEST_BYTES];
        let (md, tree, leaf) = digest_parts(&d);
        assert_eq!(md.len(), 21);
        assert_eq!(tree, (1u64 << 54) - 1);
        assert_eq!(leaf, 511);
    }
    fn wots_roundtrip<P: ParameterSet>() {
        let seed = [1; N];
        let pkseed = [2; N];
        let mut addr = Address::default();
        addr.set_type_and_clear(WOTS_HASH);
        addr.set_keypair(7);
        for digit in 0..=15 {
            let value = [3u8; N];
            let left = chain::<P>(value, 0, digit, &pkseed, addr);
            let right = chain::<P>(left, digit, 15 - digit, &pkseed, addr);
            assert_eq!(right, chain::<P>(value, 0, 15, &pkseed, addr));
            let sig = wots_sign::<P>(&value, &seed, &pkseed, addr);
            assert_eq!(
                wots_pk_from_sig::<P>(&sig, &value, &pkseed, addr),
                wots_pkgen::<P>(&seed, &pkseed, addr)
            );
        }
    }
    #[test]
    fn wots_digit_checksum_and_chain_split() {
        assert_eq!(wots_digits(&[0; N])[32..], [1, 14, 0]);
        wots_roundtrip::<Shake128s>();
        wots_roundtrip::<Sha2_128s>();
    }
    fn from_hex<const M: usize>(s: &str) -> [u8; M] {
        assert_eq!(s.len(), M * 2);
        let mut out = [0u8; M];
        for (i, octet) in out.iter_mut().enumerate() {
            *octet = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }
    #[test]
    fn independent_python_deterministic_fixture() {
        // SLH-DSA-SHAKE-128s fixture calculated by standalone Python FIPS 205
        // reference, whose keygen/sign/verify interoperated with OpenSSL 3.5.
        // These expectations are immutable, independently generated test values.
        let (sk, pk) = keygen_from_seeds_with::<Shake128s>(
            from_hex("000102030405060708090a0b0c0d0e0f"),
            from_hex("101112131415161718191a1b1c1d1e1f"),
            from_hex("202122232425262728292a2b2c2d2e2f"),
        );
        assert_eq!(
            pk.to_bytes(),
            from_hex("202122232425262728292a2b2c2d2e2f89fd81fdbb5b94129b14761bdc6bf682")
        );
        let sig = sign_deterministic(b"FIPS 205 Lean Rust example", b"proof", &sk).unwrap();
        assert_eq!(
            &sig[..16],
            from_hex::<16>("e2da87200a619722682be2e9e46f5997").as_slice()
        );
        assert_eq!(&sig[..64], from_hex::<64>(
            "e2da87200a619722682be2e9e46f59970d37351760ca6295bf0cc55118c061aba6138230888f3c48745c82934d67e221c70cee8400e5c0efcc63c9f36a56ec8a").as_slice());
        assert_eq!(
            shake::<32>(&[sig.as_slice()]),
            from_hex("74ecb05727b9b17655d9d7370328231a9126dfa29e863450b42875f05f5cd534")
        );
        assert!(verify(b"FIPS 205 Lean Rust example", b"proof", &sig, &pk).unwrap());
    }
    #[test]
    fn openssl_sha2_deterministic_fixture() {
        // SLH-DSA-SHA2-128s fixture produced by OpenSSL 3.5.7:
        //   openssl genpkey -algorithm SLH-DSA-SHA2-128s -pkeyopt hexseed:<48 bytes below>
        //   openssl pkeyutl -sign -pkeyopt deterministic:1 -pkeyopt context-string:proof
        // Fingerprint is SHA-256 of the full 7,856-byte signature.
        let (sk, pk) = keygen_from_seeds(
            from_hex("000102030405060708090a0b0c0d0e0f"),
            from_hex("101112131415161718191a1b1c1d1e1f"),
            from_hex("202122232425262728292a2b2c2d2e2f"),
        );
        assert_eq!(pk.algorithm(), "SLH-DSA-SHA2-128s");
        assert_eq!(
            pk.to_bytes(),
            from_hex("202122232425262728292a2b2c2d2e2f990ce6298792b128846a8e4a3a68954c")
        );
        let sig = sign_deterministic(b"FIPS 205 Lean Rust example", b"proof", &sk).unwrap();
        assert_eq!(&sig[..64], from_hex::<64>(
            "3631d8f90b4e6425191dff0519f40ecb0ac32a00bcf612126f38146fe894b8a831939e8cb4aaaa7c9157e078f989e220b9549186af442acf48d275851a0cb18a").as_slice());
        assert_eq!(
            sha256(&[sig.as_slice()]),
            from_hex("90400fe57abdcb33de6faf567ff0da693f61e72b373d0bb91e625e852f742ae5")
        );
        assert!(verify(b"FIPS 205 Lean Rust example", b"proof", &sig, &pk).unwrap());
    }
    #[test]
    fn hash_families_are_not_interchangeable() {
        let seeds = ([1; N], [2; N], [3; N]);
        let (sk2, pk2) = keygen_from_seeds_with::<Sha2_128s>(seeds.0, seeds.1, seeds.2);
        let (_, pk3) = keygen_from_seeds_with::<Shake128s>(seeds.0, seeds.1, seeds.2);
        assert_ne!(pk2.to_bytes(), pk3.to_bytes());
        let sig = sign_deterministic(b"m", b"", &sk2).unwrap();
        // Same bytes reinterpreted as a SHAKE key must not verify a SHA2 signature.
        let as_shake = PublicKey::<Shake128s>::from_bytes(pk2.to_bytes());
        assert!(!verify(b"m", b"", &sig, &as_shake).unwrap());
    }

    fn end_to_end<P: ParameterSet>() {
        let (sk, pk) = keygen_from_seeds_with::<P>([1; N], [2; N], [3; N]);
        assert!(sk.has_valid_root());
        assert_eq!(sk.public_key(), pk);
        let sig = sign_deterministic(b"hello", b"context", &sk).unwrap();
        assert_eq!(sig.len(), SIG_BYTES);
        assert!(verify(b"hello", b"context", &sig, &pk).unwrap());
        assert!(!verify(b"hello2", b"context", &sig, &pk).unwrap());
        assert!(!verify(b"hello", b"other", &sig, &pk).unwrap());
        assert!(!verify(b"hello", b"context", &sig[..sig.len() - 1], &pk).unwrap());
        let mut bad = sig.clone();
        bad[50] ^= 1;
        assert!(!verify(b"hello", b"context", &bad, &pk).unwrap());
        let hedged = sign_with_randomness(b"hello", b"context", &sk, [9; N]).unwrap();
        assert!(verify(b"hello", b"context", &hedged, &pk).unwrap());
        assert_ne!(sig, hedged);
        assert_eq!(
            sign_deterministic(b"hi", &[0; 256], &sk),
            Err(Error::ContextTooLong)
        );
    }
    #[test]
    fn end_to_end_and_tampering() {
        end_to_end::<Sha2_128s>();
        end_to_end::<Shake128s>();
    }
}
