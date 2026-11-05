//! `rslh` command-line tool for the FIPS 205 128s research implementation.
//!
//! Key file format (text, one line): `<ALGORITHM>:<hex>`, e.g.
//! `SLH-DSA-SHA2-128s:2021...`. The algorithm is read from the key file, so
//! `sign` and `verify` need no `--alg`. Signatures are raw 7,856-byte binary
//! files (the same format `openssl pkeyutl -sigfile` uses).
//!
//! WARNING: research code; see README.md before using for anything real.

use rslh as slh;
use slh::{
    ParameterSet, PublicKey, SecretKey, Sha2_128s, Shake128s, N, PK_BYTES, SIG_BYTES, SK_BYTES,
};
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::ExitCode;

const USAGE: &str = "\
rslh — FIPS 205 SLH-DSA-SHA2-128s / SLH-DSA-SHAKE-128s (research code)

USAGE:
  rslh keygen   --sk FILE --pk FILE [--alg sha2|shake] [--seed HEX96] [--force]
  rslh pubkey   --sk FILE --pk FILE [--force]
  rslh sign     --sk FILE --sig FILE [--in FILE] [CONTEXT] [--deterministic | --randomness HEX32] [--force]
  rslh verify   --pk FILE --sig FILE [--in FILE] [CONTEXT]
  rslh check    --sk FILE
  rslh info     --key FILE
  rslh export   --key FILE --out FILE [--force]
  rslh import   --raw FILE --out FILE [--alg sha2|shake] [--force]
  rslh help

COMMANDS:
  keygen   Generate a key pair (OS randomness, or --seed = SK.seed||SK.prf||PK.seed, 48 bytes hex)
  pubkey   Write the public key contained in a private key file
  sign     Sign a message (hedged with OS randomness by default)
  verify   Verify a signature; exit status 0 = valid, 1 = invalid, 2 = error
  check    Recompute the hypertree root and check it matches the private key (slow)
  info     Show the algorithm and type of a key file
  export   Write a key as raw bytes (64-byte private / 32-byte public, OpenSSL/FIPS 205 layout)
  import   Wrap raw 64- or 32-byte key material into a key file (type picked by length)

OPTIONS:
  --in FILE           Message file; omitted or '-' reads stdin
  --context TEXT      FIPS 205 context string (UTF-8, at most 255 bytes); default empty
  --context-hex HEX   Context string given as hex
  --alg sha2|shake    Parameter set for keygen/import (default: sha2)
  --force             Overwrite existing output files

EXAMPLES:
  # Generate a key pair (SHA2-128s default, or SHAKE-128s)
  rslh keygen --sk me.key --pk me.pub
  rslh keygen --alg shake --sk s.key --pk s.pub

  # Sign and verify a file (hedged, with a context string)
  rslh sign   --sk me.key --in msg.txt --sig msg.sig --context app
  rslh verify --pk me.pub --in msg.txt --sig msg.sig --context app

  # Deterministic signature, message from stdin, overwrite existing output
  echo hello | rslh sign --sk me.key --sig msg.sig --deterministic --force
  echo hello | rslh verify --pk me.pub --sig msg.sig

  # Key management
  rslh pubkey --sk me.key --pk me.pub --force
  rslh check  --sk me.key
  rslh info   --key me.pub

  # Exchange keys with OpenSSL (raw FIPS 205 layout)
  rslh export --key me.key --out me.raw
  rslh import --raw me.raw --out me2.key --alg sha2
  # Signatures are OpenSSL-compatible (me_pub.pem = OpenSSL's PEM of the same key)
  openssl pkeyutl -verify -pubin -inkey me_pub.pem -in msg.txt -sigfile msg.sig
";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Alg {
    Sha2,
    Shake,
}

impl Alg {
    fn name(self) -> &'static str {
        match self {
            Alg::Sha2 => Sha2_128s::NAME,
            Alg::Shake => Shake128s::NAME,
        }
    }
    fn parse_flag(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "sha2" | "sha256" | "sha2-128s" | "slh-dsa-sha2-128s" => Ok(Alg::Sha2),
            "shake" | "shake256" | "shake-128s" | "slh-dsa-shake-128s" => Ok(Alg::Shake),
            _ => Err(format!("unknown algorithm '{s}' (use sha2 or shake)")),
        }
    }
    fn from_name(s: &str) -> Option<Self> {
        [Alg::Sha2, Alg::Shake].into_iter().find(|a| a.name() == s)
    }
}

/// Minimal flag parser: `--name value` pairs plus boolean switches.
struct Args {
    pairs: Vec<(String, Option<String>)>,
}

const SWITCHES: &[&str] = &["--force", "--deterministic"];
const VALUED: &[&str] = &[
    "--sk",
    "--pk",
    "--sig",
    "--in",
    "--out",
    "--key",
    "--raw",
    "--alg",
    "--seed",
    "--context",
    "--context-hex",
    "--randomness",
];

impl Args {
    fn parse(raw: &[String], allowed: &[&str]) -> Result<Self, String> {
        let mut pairs: Vec<(String, Option<String>)> = Vec::new();
        let mut it = raw.iter();
        while let Some(flag) = it.next() {
            if !allowed.contains(&flag.as_str()) {
                return Err(format!("unexpected argument '{flag}' for this command"));
            }
            if pairs.iter().any(|(f, _)| f == flag) {
                return Err(format!("{flag} given more than once"));
            }
            if SWITCHES.contains(&flag.as_str()) {
                pairs.push((flag.clone(), None));
            } else {
                debug_assert!(VALUED.contains(&flag.as_str()));
                let v = it.next().ok_or_else(|| format!("{flag} needs a value"))?;
                pairs.push((flag.clone(), Some(v.clone())));
            }
        }
        Ok(Args { pairs })
    }
    fn get(&self, flag: &str) -> Option<&str> {
        self.pairs
            .iter()
            .find(|(f, _)| f == flag)
            .and_then(|(_, v)| v.as_deref())
    }
    fn req(&self, flag: &str) -> Result<&str, String> {
        self.get(flag)
            .ok_or_else(|| format!("missing required {flag} FILE"))
    }
    fn has(&self, flag: &str) -> bool {
        self.pairs.iter().any(|(f, _)| f == flag)
    }
    fn alg(&self) -> Result<Alg, String> {
        self.get("--alg").map_or(Ok(Alg::Sha2), Alg::parse_flag)
    }
    fn context(&self) -> Result<Vec<u8>, String> {
        let ctx = match (self.get("--context"), self.get("--context-hex")) {
            (Some(_), Some(_)) => return Err("use only one of --context / --context-hex".into()),
            (Some(t), None) => t.as_bytes().to_vec(),
            (None, Some(h)) => from_hex(h, "--context-hex")?,
            (None, None) => Vec::new(),
        };
        if ctx.len() > 255 {
            return Err(format!(
                "context is {} bytes; FIPS 205 allows at most 255",
                ctx.len()
            ));
        }
        Ok(ctx)
    }
}

fn from_hex(s: &str, what: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    if !s.len().is_multiple_of(2) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("{what}: invalid hex"));
    }
    Ok((0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect())
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn fixed<const M: usize>(v: &[u8], what: &str) -> Result<[u8; M], String> {
    v.try_into()
        .map_err(|_| format!("{what}: expected {M} bytes, got {}", v.len()))
}

fn read_file(path: &str) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("cannot read {path}: {e}"))
}

fn read_message(args: &Args) -> Result<Vec<u8>, String> {
    match args.get("--in") {
        None | Some("-") => {
            let mut buf = Vec::new();
            io::stdin()
                .read_to_end(&mut buf)
                .map_err(|e| format!("cannot read stdin: {e}"))?;
            Ok(buf)
        }
        Some(path) => read_file(path),
    }
}

/// Write a file, refusing to overwrite unless `--force`; `secret` files get mode 0600.
fn write_file(path: &str, data: &[u8], force: bool, secret: bool) -> Result<(), String> {
    if !force && Path::new(path).exists() {
        return Err(format!("{path} already exists (use --force to overwrite)"));
    }
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if secret {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = secret;
    let mut f = opts
        .open(path)
        .map_err(|e| format!("cannot write {path}: {e}"))?;
    f.write_all(data)
        .map_err(|e| format!("cannot write {path}: {e}"))
}

#[derive(Debug, PartialEq, Eq)]
enum KeyKind {
    Secret,
    Public,
}

struct KeyFile {
    alg: Alg,
    kind: KeyKind,
    bytes: Vec<u8>,
}

fn encode_key(alg: Alg, bytes: &[u8]) -> Vec<u8> {
    format!("{}:{}\n", alg.name(), to_hex(bytes)).into_bytes()
}

fn load_key(path: &str) -> Result<KeyFile, String> {
    let text = String::from_utf8(read_file(path)?)
        .map_err(|_| format!("{path}: not a key file (expected '<ALGORITHM>:<hex>' text)"))?;
    let (name, hex) = text
        .trim()
        .split_once(':')
        .ok_or_else(|| format!("{path}: not a key file (expected '<ALGORITHM>:<hex>')"))?;
    let alg =
        Alg::from_name(name).ok_or_else(|| format!("{path}: unsupported algorithm '{name}'"))?;
    let bytes = from_hex(hex, path)?;
    let kind = match bytes.len() {
        SK_BYTES => KeyKind::Secret,
        PK_BYTES => KeyKind::Public,
        n => {
            return Err(format!(
                "{path}: {n}-byte key; expected {SK_BYTES} (private) or {PK_BYTES} (public)"
            ))
        }
    };
    Ok(KeyFile { alg, kind, bytes })
}

fn load_kind(path: &str, want: KeyKind) -> Result<KeyFile, String> {
    let key = load_key(path)?;
    if key.kind != want {
        let w = if want == KeyKind::Secret {
            "private"
        } else {
            "public"
        };
        return Err(format!("{path} is not a {w} key"));
    }
    Ok(key)
}

fn err_str(e: slh::Error) -> String {
    match e {
        slh::Error::RandomnessUnavailable => "OS randomness unavailable".into(),
        slh::Error::ContextTooLong => "context longer than 255 bytes".into(),
        slh::Error::InvalidLength => "invalid length".into(),
    }
}

// ---- commands -----------------------------------------------------------

fn keygen_typed<P: ParameterSet>(seed: Option<&[u8]>) -> Result<(Vec<u8>, Vec<u8>), String> {
    let (sk, pk) = match seed {
        Some(s) => slh::keygen_from_seeds_with::<P>(
            fixed(&s[..N], "seed")?,
            fixed(&s[N..2 * N], "seed")?,
            fixed(&s[2 * N..], "seed")?,
        ),
        None => slh::generate_keypair_with::<P>().map_err(err_str)?,
    };
    Ok((sk.to_bytes().to_vec(), pk.to_bytes().to_vec()))
}

fn cmd_keygen(a: &Args) -> Result<(), String> {
    let (sk_path, pk_path) = (a.req("--sk")?, a.req("--pk")?);
    if sk_path == pk_path {
        return Err("--sk and --pk must be different files".into());
    }
    let force = a.has("--force");
    for p in [sk_path, pk_path] {
        if !force && Path::new(p).exists() {
            return Err(format!("{p} already exists (use --force to overwrite)"));
        }
    }
    let alg = a.alg()?;
    let seed = a.get("--seed").map(|h| from_hex(h, "--seed")).transpose()?;
    if let Some(s) = &seed {
        if s.len() != 3 * N {
            return Err(format!(
                "--seed must be {} bytes (SK.seed||SK.prf||PK.seed), got {}",
                3 * N,
                s.len()
            ));
        }
        eprintln!("warning: deterministic keygen from --seed; only for tests/known-answer vectors");
    }
    let (sk, pk) = match alg {
        Alg::Sha2 => keygen_typed::<Sha2_128s>(seed.as_deref())?,
        Alg::Shake => keygen_typed::<Shake128s>(seed.as_deref())?,
    };
    write_file(sk_path, &encode_key(alg, &sk), force, true)?;
    write_file(pk_path, &encode_key(alg, &pk), force, false)?;
    println!(
        "{}: private key -> {sk_path}, public key -> {pk_path}",
        alg.name()
    );
    println!("public key: {}", to_hex(&pk));
    Ok(())
}

fn cmd_pubkey(a: &Args) -> Result<(), String> {
    let key = load_kind(a.req("--sk")?, KeyKind::Secret)?;
    let out = a.req("--pk")?;
    write_file(
        out,
        &encode_key(key.alg, &key.bytes[2 * N..]),
        a.has("--force"),
        false,
    )?;
    println!("{}: public key -> {out}", key.alg.name());
    Ok(())
}

fn sign_typed<P: ParameterSet>(
    sk: [u8; SK_BYTES],
    msg: &[u8],
    ctx: &[u8],
    mode: Option<Option<[u8; N]>>,
) -> Result<Vec<u8>, String> {
    let sk = SecretKey::<P>::from_bytes(sk);
    match mode {
        None => slh::sign(msg, ctx, &sk),
        Some(None) => slh::sign_deterministic(msg, ctx, &sk),
        Some(Some(r)) => slh::sign_with_randomness(msg, ctx, &sk, r),
    }
    .map_err(err_str)
}

fn cmd_sign(a: &Args) -> Result<(), String> {
    let key = load_kind(a.req("--sk")?, KeyKind::Secret)?;
    let sig_path = a.req("--sig")?;
    if !a.has("--force") && Path::new(sig_path).exists() {
        return Err(format!(
            "{sig_path} already exists (use --force to overwrite)"
        ));
    }
    let ctx = a.context()?;
    // None = hedged with OS randomness; Some(None) = deterministic; Some(Some(r)) = explicit.
    let mode = match (a.has("--deterministic"), a.get("--randomness")) {
        (true, Some(_)) => return Err("use only one of --deterministic / --randomness".into()),
        (true, None) => Some(None),
        (false, Some(h)) => Some(Some(fixed(&from_hex(h, "--randomness")?, "--randomness")?)),
        (false, None) => None,
    };
    let msg = read_message(a)?;
    let sk: [u8; SK_BYTES] = fixed(&key.bytes, "private key")?;
    let sig = match key.alg {
        Alg::Sha2 => sign_typed::<Sha2_128s>(sk, &msg, &ctx, mode)?,
        Alg::Shake => sign_typed::<Shake128s>(sk, &msg, &ctx, mode)?,
    };
    write_file(sig_path, &sig, a.has("--force"), false)?;
    println!(
        "{}: {}-byte signature -> {sig_path}",
        key.alg.name(),
        sig.len()
    );
    Ok(())
}

fn verify_typed<P: ParameterSet>(
    pk: [u8; PK_BYTES],
    msg: &[u8],
    ctx: &[u8],
    sig: &[u8],
) -> Result<bool, String> {
    slh::verify(msg, ctx, sig, &PublicKey::<P>::from_bytes(pk)).map_err(err_str)
}

fn cmd_verify(a: &Args) -> Result<bool, String> {
    let key = load_kind(a.req("--pk")?, KeyKind::Public)?;
    let sig = read_file(a.req("--sig")?)?;
    let ctx = a.context()?;
    let msg = read_message(a)?;
    if sig.len() != SIG_BYTES {
        eprintln!(
            "note: signature is {} bytes, expected {SIG_BYTES}",
            sig.len()
        );
    }
    let pk: [u8; PK_BYTES] = fixed(&key.bytes, "public key")?;
    let ok = match key.alg {
        Alg::Sha2 => verify_typed::<Sha2_128s>(pk, &msg, &ctx, &sig)?,
        Alg::Shake => verify_typed::<Shake128s>(pk, &msg, &ctx, &sig)?,
    };
    println!(
        "{}: signature {}",
        key.alg.name(),
        if ok { "VALID" } else { "INVALID" }
    );
    Ok(ok)
}

fn cmd_check(a: &Args) -> Result<bool, String> {
    let key = load_kind(a.req("--sk")?, KeyKind::Secret)?;
    let sk: [u8; SK_BYTES] = fixed(&key.bytes, "private key")?;
    let ok = match key.alg {
        Alg::Sha2 => SecretKey::<Sha2_128s>::from_bytes(sk).has_valid_root(),
        Alg::Shake => SecretKey::<Shake128s>::from_bytes(sk).has_valid_root(),
    };
    println!(
        "{}: private key root {}",
        key.alg.name(),
        if ok { "OK" } else { "MISMATCH" }
    );
    Ok(ok)
}

fn cmd_info(a: &Args) -> Result<(), String> {
    let path = a.req("--key")?;
    let key = load_key(path)?;
    println!("file:      {path}");
    println!("algorithm: {}", key.alg.name());
    match key.kind {
        KeyKind::Secret => {
            println!("type:      private key ({SK_BYTES} bytes)");
            println!("public:    {}", to_hex(&key.bytes[2 * N..]));
        }
        KeyKind::Public => {
            println!("type:      public key ({PK_BYTES} bytes)");
            println!("public:    {}", to_hex(&key.bytes));
        }
    }
    Ok(())
}

fn cmd_export(a: &Args) -> Result<(), String> {
    let key = load_key(a.req("--key")?)?;
    let out = a.req("--out")?;
    write_file(
        out,
        &key.bytes,
        a.has("--force"),
        key.kind == KeyKind::Secret,
    )?;
    println!("{}: {} raw bytes -> {out}", key.alg.name(), key.bytes.len());
    Ok(())
}

fn cmd_import(a: &Args) -> Result<(), String> {
    let raw = read_file(a.req("--raw")?)?;
    let out = a.req("--out")?;
    let alg = a.alg()?;
    let secret = match raw.len() {
        SK_BYTES => true,
        PK_BYTES => false,
        n => {
            return Err(format!(
                "raw key is {n} bytes; expected {SK_BYTES} (private) or {PK_BYTES} (public)"
            ))
        }
    };
    write_file(out, &encode_key(alg, &raw), a.has("--force"), secret)?;
    println!(
        "{}: {} key -> {out}",
        alg.name(),
        if secret { "private" } else { "public" }
    );
    if secret {
        println!(
            "tip: run `rslh check --sk {out}` to confirm the key matches {}",
            alg.name()
        );
    }
    Ok(())
}

fn run(argv: &[String]) -> Result<ExitCode, String> {
    let Some(cmd) = argv.first() else {
        eprint!("{USAGE}");
        return Ok(ExitCode::from(2));
    };
    let rest = &argv[1..];
    let ctx = ["--context", "--context-hex"];
    let ok = |b: bool| {
        if b {
            ExitCode::SUCCESS
        } else {
            ExitCode::from(1)
        }
    };
    match cmd.as_str() {
        "keygen" => cmd_keygen(&Args::parse(
            rest,
            &["--sk", "--pk", "--alg", "--seed", "--force"],
        )?)?,
        "pubkey" => cmd_pubkey(&Args::parse(rest, &["--sk", "--pk", "--force"])?)?,
        "sign" => cmd_sign(&Args::parse(
            rest,
            &[
                &[
                    "--sk",
                    "--sig",
                    "--in",
                    "--deterministic",
                    "--randomness",
                    "--force",
                ][..],
                &ctx,
            ]
            .concat(),
        )?)?,
        "verify" => {
            return Ok(ok(cmd_verify(&Args::parse(
                rest,
                &[&["--pk", "--sig", "--in"][..], &ctx].concat(),
            )?)?))
        }
        "check" => return Ok(ok(cmd_check(&Args::parse(rest, &["--sk"])?)?)),
        "info" => cmd_info(&Args::parse(rest, &["--key"])?)?,
        "export" => cmd_export(&Args::parse(rest, &["--key", "--out", "--force"])?)?,
        "import" => cmd_import(&Args::parse(rest, &["--raw", "--out", "--alg", "--force"])?)?,
        "help" | "-h" | "--help" => print!("{USAGE}"),
        other => return Err(format!("unknown command '{other}' (try `rslh help`)")),
    }
    Ok(ExitCode::SUCCESS)
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match run(&argv) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(2)
        }
    }
}
