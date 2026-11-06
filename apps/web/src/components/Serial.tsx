import { serialGlyphs } from "../design/helpers.js";

/** "Nº ABCD·WXYZ" serial engraved under an account seal. */
export function Serial({ address }: { address: string }) {
  return (
    <div className="serial-wrap" aria-label={`Account ${address}`}>
      <span className="no">Nº</span>
      <span className="serial">
        {serialGlyphs(address).map((glyph, index) => (
          <span key={index} style={{ fontSize: `${glyph.size}px` }}>
            {glyph.ch}
          </span>
        ))}
      </span>
    </div>
  );
}
