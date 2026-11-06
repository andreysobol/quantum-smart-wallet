import { useEffect, useState, type KeyboardEvent } from "react";
import { cx } from "../components/Seal.js";
import { downloadBackup, readBackupFile } from "../crypto/signer.js";
import { SignerError } from "../crypto/types.js";
import { short } from "../design/helpers.js";
import { describeError } from "../state/engrave.js";
import { useWallet } from "../state/wallet.js";

export const MIN_PASSPHRASE = 10;

/** Rough strength hint (character-class entropy estimate; it cannot see dictionary words). */
export function passphraseHint(pass: string, confirm: string): string {
  if (pass.length < MIN_PASSPHRASE) return `At least ${MIN_PASSPHRASE} characters · ${pass.length} / ${MIN_PASSPHRASE}`;
  if (confirm && confirm !== pass) return "The passphrases do not match";
  let pool = 0;
  if (/[a-z]/.test(pass)) pool += 26;
  if (/[A-Z]/.test(pass)) pool += 26;
  if (/[0-9]/.test(pass)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pass)) pool += 33;
  const bits = Math.round(pass.length * Math.log2(Math.max(pool, 2)));
  const label = bits < 50 ? "weak: add words or symbols" : bits < 70 ? "fair" : bits < 90 ? "strong" : "very strong";
  return `Estimated ${bits} bits · ${label}${confirm === pass ? "" : " · repeat it below"}`;
}

function checkMessage(error: unknown): string {
  if (error instanceof SignerError) {
    if (error.code === "bad_passphrase") return "Wrong passphrase for this backup file.";
    if (error.code === "key_mismatch") return "This backup holds a different key than this wallet.";
  }
  return describeError(error);
}

type Stage = "plate" | "quiz" | "sealed";

export function Backup() {
  const { wallet, signer, setWallet, go, finishOnboarding } = useWallet();
  const [stage, setStage] = useState<Stage>("plate");
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [checkPass, setCheckPass] = useState("");
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (stage !== "sealed") return;
    const timer = setTimeout(() => go("portfolio"), 1600);
    return () => clearTimeout(timer);
  }, [stage, go]);

  if (!wallet) return null;
  const valid = pass.length >= MIN_PASSPHRASE && pass === confirm;

  const download = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      downloadBackup(await signer.exportBackup(wallet.publicKey, pass));
      setPass("");
      setConfirm("");
      setRevealed(false);
      setStage("quiz");
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    if (!file || !checkPass || busy) return;
    setBusy(true);
    setError(null);
    setWrong(false);
    try {
      const backup = await readBackupFile(file);
      if (!(await signer.verifyBackup(backup, checkPass, wallet.publicKey))) {
        throw new SignerError("key_mismatch", "This backup holds a different key than this wallet.");
      }
      setCheckPass("");
      if (!setWallet({ ...wallet, backedUp: true })) {
        setError("Another tab replaced the wallet on this device, so this check was not recorded.");
        return;
      }
      finishOnboarding();
      setStage("sealed");
    } catch (failure) {
      setWrong(true);
      setError(checkMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const later = () => {
    finishOnboarding();
    go("portfolio");
  };
  const toStage = (next: Stage) => {
    setError(null);
    setWrong(false);
    setStage(next);
  };
  const revealKey = (event: KeyboardEvent) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      setRevealed(true);
    }
  };
  const fieldType = revealed ? "text" : "password";

  return (
    <section className="scr narrow" aria-labelledby="bk-h">
      {stage === "plate" && (
        <>
          <h2 className="s-h" id="bk-h">
            Back up
          </h2>
          <p className="lede">
            No words to write down. Choose a passphrase and save the encrypted backup file: together they are the only
            way to restore this wallet.
          </p>
          <div className={cx("plate", revealed && "shown")}>
            <div className="pp">
              <label className="lab" htmlFor="bk-p1">
                Passphrase
              </label>
              <input
                id="bk-p1"
                className="fld mono"
                type={fieldType}
                autoComplete="new-password"
                spellCheck={false}
                value={pass}
                onChange={(event) => setPass(event.target.value)}
                aria-describedby="bk-hint"
              />
              <label className="lab" htmlFor="bk-p2">
                Repeat passphrase
              </label>
              <input
                id="bk-p2"
                className="fld mono"
                type={fieldType}
                autoComplete="new-password"
                spellCheck={false}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void download()}
                aria-describedby="bk-hint"
              />
              <p className="hint mono" id="bk-hint" aria-live="polite">
                {passphraseHint(pass, confirm)}
              </p>
            </div>
            <div className="veil" aria-hidden="true"></div>
          </div>
          <div className="row">
            <button
              type="button"
              className="btn ghost"
              onPointerDown={() => setRevealed(true)}
              onPointerUp={() => setRevealed(false)}
              onPointerLeave={() => setRevealed(false)}
              onKeyDown={revealKey}
              onKeyUp={() => setRevealed(false)}
              aria-pressed={revealed}
            >
              {revealed ? "Release to hide" : "Hold to reveal"}
            </button>
            <button className="btn" onClick={() => void download()} disabled={!valid || busy}>
              {busy ? "Encrypting…" : "Download backup"}
            </button>
            <button className="link" onClick={later}>
              Later
            </button>
          </div>
          {error && (
            <p className="err mono" role="alert">
              {error}
            </p>
          )}
          <button className="link" onClick={() => toStage("quiz")}>
            I already saved a backup file
          </button>
        </>
      )}
      {stage === "quiz" && (
        <>
          <h2 className="s-h" id="bk-h">
            Check
          </h2>
          <p className="lede">
            Prove the file works: choose the backup you just saved and type its passphrase. It is decrypted inside the
            signer and compared with this wallet’s key. Nothing is stored.
          </p>
          <fieldset className="qz">
            <legend>Backup file</legend>
            <div className="opts">
              <label className={cx("opt", "pick", wrong && "wrong")}>
                <input
                  className="vh"
                  type="file"
                  accept=".json,application/json"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setWrong(false);
                    setError(null);
                  }}
                />
                {file ? file.name : "Choose file"}
              </label>
            </div>
          </fieldset>
          <fieldset className="qz">
            <legend>Passphrase</legend>
            <input
              className="fld mono"
              type="password"
              autoComplete="current-password"
              spellCheck={false}
              aria-label="Backup passphrase"
              value={checkPass}
              onChange={(event) => setCheckPass(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void check()}
            />
          </fieldset>
          <div className="row">
            <button className="btn" onClick={() => void check()} disabled={!file || !checkPass || busy}>
              {busy ? "Checking…" : "Seal backup"}
            </button>
            <button className="link" onClick={() => toStage("plate")}>
              Make a new backup file
            </button>
          </div>
          {error && (
            <p className="err mono" role="alert">
              {error}
            </p>
          )}
        </>
      )}
      {stage === "sealed" && (
        <>
          <h2 className="s-h" id="bk-h">
            Backed up
          </h2>
          <div className="sealed">
            <div className="plate veiled">
              <ol className="words">
                {["SLH-DSA", "SHA2-128s", "PBKDF2", "600,000", "AES-GCM", "256-bit", short(wallet.publicKey), short(wallet.account)].map(
                  (word, index) => (
                    <li key={index}>
                      <span className="wn mono">{String(index + 1).padStart(2, "0")}</span>
                      <span className="ww">{word}</span>
                    </li>
                  ),
                )}
              </ol>
            </div>
            <div className="stamp" aria-hidden="true">
              <span className="st1">Sealed</span>
            </div>
          </div>
          <p className="vh" role="status">
            Backup verified and sealed.
          </p>
        </>
      )}
    </section>
  );
}
