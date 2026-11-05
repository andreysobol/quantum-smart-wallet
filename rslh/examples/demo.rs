use rslh::{
    generate_keypair, generate_keypair_with, sign, verify, ParameterSet, PublicKey, SecretKey,
    Shake128s, SIG_BYTES,
};

fn run<P: ParameterSet>(sk: &SecretKey<P>, pk: &PublicKey<P>) -> Result<(), Box<dyn std::error::Error>> {
    let message = b"FIPS 205 SLH-DSA-128s";
    let context = b"example";
    let signature = sign(message, context, sk).map_err(|e| format!("sign: {e:?}"))?;
    let accepted = verify(message, context, &signature, pk)
        .map_err(|e| format!("verify: {e:?}"))?;
    println!("{}: signature size {} (expected {}), valid: {accepted}",
             pk.algorithm(), signature.len(), SIG_BYTES);
    if !accepted { return Err("signature unexpectedly rejected".into()); }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Default parameter set: SLH-DSA-SHA2-128s.
    let (sk, pk) = generate_keypair().map_err(|e| format!("keygen: {e:?}"))?;
    run(&sk, &pk)?;
    // Explicitly selected: SLH-DSA-SHAKE-128s.
    let (sk, pk) = generate_keypair_with::<Shake128s>().map_err(|e| format!("keygen: {e:?}"))?;
    run(&sk, &pk)
}
