import { useState, type DragEvent } from "react";
import { cx } from "../components/Seal.js";
import { readBackupFile } from "../crypto/signer.js";
import { SignerError } from "../crypto/types.js";
import { describeError } from "../state/engrave.js";
import { useWallet } from "../state/wallet.js";
import { ReplaceWallet } from "./Genesis.js";

function restoreMessage(error: unknown): string {
  if (error instanceof SignerError && error.code === "bad_passphrase") return "Wrong passphrase for this backup file.";
  return describeError(error);
}

export function Restore() {
  const { go, signer, keyNotice, restoreWallet } = useWallet();
  const [file, setFile] = useState<File | null>(null);
  const [pass, setPass] = useState("");
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = !file || !pass || busy;

  const choose = (next: File | null | undefined) => {
    setFile(next ?? null);
    setError(null);
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    choose(event.dataTransfer.files[0]);
  };

  const restore = async () => {
    if (!file || !pass || busy) return;
    setBusy(true);
    setError(null);
    try {
      const backup = await readBackupFile(file);
      const { publicKey, meta } = await signer.importBackup(backup, pass);
      setPass("");
      setBusy(false);
      restoreWallet(publicKey, meta);
    } catch (failure) {
      setError(restoreMessage(failure));
      setBusy(false);
    }
  };

  return (
    <section className="scr narrow" aria-labelledby="rst-h">
      <h2 className="s-h" id="rst-h">
        Restore
      </h2>
      {keyNotice && <p className="lede">{keyNotice}</p>}
      <label className="lab" htmlFor="rf">
        Your backup file
      </label>
      <label
        className={cx("ta", "mono", "drop", over && "over")}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <input id="rf" className="vh" type="file" accept=".json,application/json" onChange={(event) => choose(event.target.files?.[0])} />
        {file ? file.name : "Choose or drop your qsw-backup-….json file"}
      </label>
      <label className="lab" htmlFor="rp">
        Passphrase
      </label>
      <input
        id="rp"
        className="fld mono"
        type="password"
        autoComplete="current-password"
        spellCheck={false}
        value={pass}
        onChange={(event) => setPass(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && void restore()}
      />
      <div className="row">
        <button className="btn" onClick={() => void restore()} disabled={locked}>
          {busy ? "Decrypting…" : "Restore"}
        </button>
        <button className="btn ghost" onClick={() => go("genesis")}>
          Back
        </button>
      </div>
      <ReplaceWallet action="restore" />
      {error && (
        <p className="err mono" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
