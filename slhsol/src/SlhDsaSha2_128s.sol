// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SLH-DSA-SHA2-128s verifier (NIST FIPS 205, Algorithms 20 and 24)
/// @notice Pure (non-prehash) verification with a context string, matching the
///         `rslh` Rust implementation and OpenSSL. Parameters: n=16, h=63, d=7,
///         h'=9, a=12, k=14, w=16, len=35. Every hash goes through the SHA-256
///         precompile (address 0x02).
/// @dev    Research code: not audited. Requires EVM >= Cancun (uses MCOPY).
///
///         Scratch layout for tweakable hashes (FIPS 205 Section 11.2):
///           [0,16)   PK.seed
///           [16,64)  toByte(0, 48)        -> PK.seed padded to one SHA-256 block
///           [64,86)  ADRSc (22 bytes):
///                      64 layer | 65..73 tree | 73 type | 74 keypair
///                      78 chain/height | 82 hash/index
///           [86, ..) message input (16, 32, 224 or 560 bytes)
library SlhDsaSha2_128s {
    uint256 internal constant N = 16;
    uint256 internal constant PK_BYTES = 32;
    uint256 internal constant SIG_BYTES = 7856;

    error ContextTooLong();

    /// @notice FIPS 205 Algorithm 24 (slh_verify), pure variant.
    /// @param pk      PK.seed || PK.root (32 bytes)
    /// @param message the signed message
    /// @param ctx     context string, at most 255 bytes (reverts otherwise)
    /// @param sig     7,856-byte signature
    /// @return true if the signature is valid; false for any wrong length or invalid signature
    function verify(bytes calldata pk, bytes calldata message, bytes calldata ctx, bytes calldata sig)
        internal
        view
        returns (bool)
    {
        if (ctx.length > 255) revert ContextTooLong();
        if (pk.length != PK_BYTES) return false;
        bytes memory framed = abi.encodePacked(uint8(0), uint8(ctx.length), ctx, message);
        return verifyInternal(framed, sig, bytes16(pk[0:16]), bytes16(pk[16:32]));
    }

    /// @notice FIPS 205 Algorithm 20 (slh_verify_internal).
    function verifyInternal(bytes memory m, bytes calldata sig, bytes16 pkSeed, bytes16 pkRoot)
        internal
        view
        returns (bool ok)
    {
        if (sig.length != SIG_BYTES) return false;

        // H_msg (Section 11.2.1): MGF1-SHA-256(R || PK.seed || SHA-256(R || PK.seed || PK.root || M), 30).
        // 30 <= 32, so MGF1 is a single block with counter 0.
        bytes16 r = bytes16(sig[0:16]);
        bytes32 inner = sha256(abi.encodePacked(r, pkSeed, pkRoot, m));
        uint256 digest = uint256(sha256(abi.encodePacked(r, pkSeed, inner, uint32(0))));
        return _forsAndHypertree(sig, pkSeed, pkRoot, digest);
    }

    /// @dev Algorithms 17 and 13 over the FORS and hypertree parts of `sig`.
    function _forsAndHypertree(bytes calldata sig, bytes16 pkSeed, bytes16 pkRoot, uint256 digest)
        private
        view
        returns (bool ok)
    {
        assembly ("memory-safe") {
            // ---- helpers -------------------------------------------------------
            // SHA-256 over [b, b+len), truncated to n = 16 bytes (left-aligned word).
            function th(b, len) -> v {
                if iszero(staticcall(gas(), 0x02, b, len, 0x00, 0x20)) { revert(0, 0) }
                v := and(mload(0x00), shl(128, not(0)))
            }
            // Read a 16-byte block from calldata (left-aligned word).
            function blk(p) -> v { v := and(calldataload(p), shl(128, not(0))) }
            function set32(p, x) {
                mstore8(p, shr(24, x))
                mstore8(add(p, 1), shr(16, x))
                mstore8(add(p, 2), shr(8, x))
                mstore8(add(p, 3), x)
            }
            function setTree(b, t) {
                for { let k := 0 } lt(k, 8) { k := add(k, 1) } {
                    mstore8(add(b, add(65, k)), shr(mul(8, sub(7, k)), t))
                }
            }
            // ADRS.setTypeAndClear: type byte, then zero keypair/chain/hash words.
            function setTypeClear(b, ty) {
                mstore8(add(b, 73), ty)
                set32(add(b, 74), 0)
                set32(add(b, 78), 0)
                set32(add(b, 82), 0)
            }
            // Hash two children: left/right order chosen by `bit`.
            function node2(b, bit, cur, sib) -> v {
                switch bit
                case 0 {
                    mstore(add(b, 86), cur)
                    mstore(add(b, 102), sib)
                }
                default {
                    mstore(add(b, 86), sib)
                    mstore(add(b, 102), cur)
                }
                v := th(b, 118)
            }

            // ---- Algorithm 17: fors_pkFromSig ----------------------------------
            function forsPk(b, big, off, md_, leaf_) -> pk {
                setTypeClear(b, 3) // FORS_TREE
                set32(add(b, 74), leaf_)
                for { let i := 0 } lt(i, 14) { i := add(i, 1) } {
                    let idx := and(shr(sub(156, mul(12, i)), md_), 0xfff)
                    let o := add(off, mul(i, 208)) // (a + 1) * n
                    set32(add(b, 78), 0)
                    set32(add(b, 82), add(shl(12, i), idx))
                    mstore(add(b, 86), blk(o))
                    let node := th(b, 102)
                    for { let j := 0 } lt(j, 12) { j := add(j, 1) } {
                        let j1 := add(j, 1)
                        set32(add(b, 78), j1)
                        set32(add(b, 82), add(shl(sub(11, j), i), shr(j1, idx)))
                        node := node2(b, and(shr(j, idx), 1), node, blk(add(o, mul(j1, 16))))
                    }
                    mstore(add(big, add(86, mul(i, 16))), node)
                }
                setTypeClear(b, 4) // FORS_ROOTS
                set32(add(b, 74), leaf_)
                mcopy(big, b, 86)
                pk := th(big, 310) // 86 + k * n
            }

            // ---- Algorithms 8 + 11: wots_pkFromSig, xmss_pkFromSig -------------
            function xmssPk(b, big, off, leaf_, msg) -> node {
                setTypeClear(b, 0) // WOTS_HASH
                set32(add(b, 74), leaf_)
                let csum := 0
                for { let i := 0 } lt(i, 35) { i := add(i, 1) } {
                    let dgt
                    switch lt(i, 32)
                    case 1 {
                        dgt := and(shr(sub(252, mul(4, i)), msg), 15)
                        csum := add(csum, sub(15, dgt))
                    }
                    default {
                        // checksum << 4 as 16 bits; take its top three nibbles
                        dgt := and(shr(sub(12, mul(4, sub(i, 32))), shl(4, csum)), 15)
                    }
                    set32(add(b, 78), i)
                    let v := blk(add(off, mul(i, 16)))
                    for { let j := dgt } lt(j, 15) { j := add(j, 1) } {
                        set32(add(b, 82), j)
                        mstore(add(b, 86), v)
                        v := th(b, 102)
                    }
                    mstore(add(big, add(86, mul(i, 16))), v)
                }
                setTypeClear(b, 1) // WOTS_PK
                set32(add(b, 74), leaf_)
                mcopy(big, b, 86)
                node := th(big, 646) // 86 + len * n

                setTypeClear(b, 2) // TREE
                for { let j := 0 } lt(j, 9) { j := add(j, 1) } {
                    let j1 := add(j, 1)
                    set32(add(b, 78), j1)
                    set32(add(b, 82), shr(j1, leaf_))
                    node := node2(b, and(shr(j, leaf_), 1), node, blk(add(off, mul(add(35, j), 16))))
                }
            }

            // ---- Algorithm 20 body ---------------------------------------------
            let md := shr(88, digest) // first 21 bytes: 14 FORS indices of 12 bits
            let tree := and(shr(32, digest), sub(shl(54, 1), 1)) // bytes 21..28, low 54 bits
            let leaf := and(shr(16, digest), 511) // bytes 28..30, low 9 bits
            let b := mload(0x40)
            let big := add(b, 160) // b needs 86 + 32 + 16 bytes of headroom
            mstore(0x40, add(big, 672)) // 86 + 560 + slack for the last 32-byte store
            mstore(b, pkSeed)
            mstore(add(b, 32), 0)
            mstore(add(b, 64), 0)

            mstore8(add(b, 64), 0)
            setTree(b, tree)
            let node := forsPk(b, big, add(sig.offset, 16), md, leaf)

            // Algorithm 13: ht_verify
            let off := add(sig.offset, 2928) // n + k * (a + 1) * n
            for { let layer := 0 } lt(layer, 7) { layer := add(layer, 1) } {
                if layer {
                    leaf := and(tree, 511)
                    tree := shr(9, tree)
                }
                mstore8(add(b, 64), layer)
                setTree(b, tree)
                node := xmssPk(b, big, off, leaf, node)
                off := add(off, 704) // (len + h') * n
            }
            ok := eq(node, pkRoot)
        }
    }
}

/// @notice Deployable wrapper around {SlhDsaSha2_128s}.
contract SlhDsaVerifier {
    function verify(bytes calldata pk, bytes calldata message, bytes calldata ctx, bytes calldata sig)
        external
        view
        returns (bool)
    {
        return SlhDsaSha2_128s.verify(pk, message, ctx, sig);
    }
}
