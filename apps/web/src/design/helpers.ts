/**
 * helpers.ts — pure, deterministic helpers ported from the DC design prototype
 * (Main.dc.html, `class Component extends DCLogic`).
 *
 * Port rules
 * - Every `this.x()` became a module function `x()`; arithmetic, operation order,
 *   rounding (`Math.round(v * k) / k`, `toFixed`, `toLocaleString('en-US')`) and string
 *   building are copied 1:1, so outputs are byte-identical to the prototype.
 *   helpers.check.mjs proves this by running the original class next to this module.
 * - Caches: the prototype kept seal / tokenMark / tree results in one shared
 *   `this._seals` object. Here each has its own module-level Map (same keys). The only
 *   observable difference: in the prototype a key collision across kinds was possible
 *   (e.g. tokenMark('X|L') vs seal('tok|X', true)); no seed the UI uses can collide.
 *   Singletons (`_wl`, `_fb`, `_specPk`) became lazily initialised module variables.
 * - Methods that read `Date.now()` (makeTx, makeQuiz, freshState('proof')) take an
 *   explicit `now` argument that defaults to `Date.now()`, so the result is a pure
 *   function of the arguments.
 * - `renderValues(state, props)` is the data half of `renderVals()`: same keys, same
 *   order, same values, minus every handler closure (goHome, sign, pick, replay, ...).
 *   The pure logic inside some handlers is exported separately:
 *   sanitizeAmount (onAmt), maxAmount (setMax), flipAmount (flip).
 *
 * Not ported (stateful or side effects): constructor, componentDidMount/Update/
 * WillUnmount, later, stopTimer, stopAll, go, startEngrave, pickQuiz, startProof,
 * runTimer, and the handler closures. `entropy()` is deliberately left out: it falls
 * back to Math.random() when crypto is unavailable, which a real wallet must never do.
 *
 * Prototype stand-ins, NOT crypto. h32/rng/hex are a non-cryptographic hash and PRNG.
 * wordlist/mnemonic/deriveWallet are a fake 262-word list and fake keys/addresses.
 * quote/plan/makeTx/applySwap/faucetEntry simulate a swap. Use them only for visuals,
 * fixtures and demo mode. For the real account, feed the real SLH-DSA public key
 * (64 lowercase hex chars, no 0x, same shape as the prototype's `w.pk`) into
 * seal('acct|' + pk) / tree('acct|' + pk) so the art matches the prototype.
 *
 * fmt() uses Number#toLocaleString('en-US'); its output depends on the runtime's ICU
 * data, exactly as in the prototype.
 */

// ============================================================================ types

export type TokenSym = 'ETH' | 'WETH' | 'USDC';
/** The swap side only ever alternates between USDC and WETH in the prototype. */
export type SwapSym = 'USDC' | 'WETH';
export type Balances = Record<TokenSym, number>;
export type Screen = 'genesis' | 'engrave' | 'restore' | 'backup' | 'vault' | 'exchange' | 'proof';
export type BackupStage = 'plate' | 'quiz' | 'sealed';
export type FrameMode = 'DEFAULT' | 'VERIFY' | 'SENDER';
/** Uniform floats in [0, 1). */
export type Rng = () => number;

/** SVG path data for the guilloché seal; every path is drawn in viewBox="-100 -100 200 200". */
export interface SealPaths {
  braidA: string;
  braidB: string;
  ros: string;
  inner: string;
  rules: string;
  /** Circle of radius 88.5 used as the <textPath> for the public-key ring text. */
  ringPath: string;
  /** Length of ringPath (2 * PI * 88.5); drives ringFontSize(). */
  ringLen: number;
}

/** SLH-DSA-SHA2-128s hypertree drawn inside the seal: 14 FORS spokes, 7 layers, 8 climb steps. */
export interface TreeGeometry {
  spokes: string[];
  fors: string;
  layers: string[];
  climb: string[];
}

/** One UV "security fibre" in the page background; x/y are percentages, r degrees. */
export interface Fiber {
  x: string;
  y: string;
  r: number;
  s: string;
  c: string;
}

export interface Wallet {
  seed: string;
  words: string[];
  pk: string;
  addr: string;
}

export interface Quote {
  out: number;
  minOut: number;
  rate: number;
  usdOut: number;
}

export interface PlanFrame {
  mode: FrameMode;
  short: string;
  limit: number;
  used: number;
}

export interface Plan {
  frames: PlanFrame[];
  used: number;
  feeEth: number;
  feeUsd: number;
}

export interface Tx {
  id: string;
  from: SwapSym;
  to: SwapSym;
  amt: number;
  out: number;
  frames: PlanFrame[];
  used: number;
  feeEth: number;
  feeUsd: number;
  deploy: boolean;
  layerOps: number[];
  ops: number;
  block: number;
}

export interface LedgerEntry {
  id: string;
  title: string;
  meta: string;
  hash: string;
  sealSeed: string;
  tx: Tx | null;
}

export interface QuizItem {
  pos: number;
  ans: string;
  opts: string[];
  picked: string | null;
  ok: boolean;
}

export interface ProofPhase {
  name: string;
  title: string;
  end: number;
}

export interface HashUnit {
  t0: number;
  t1: number;
  n: number;
}

/** Proof animation timeline in milliseconds (see buildProof). */
export interface ProofTimeline {
  ph: ProofPhase[];
  fAppear: number[];
  fRun: number[];
  fDone: number[];
  units: HashUnit[];
  spokeAt: number[];
  layerStart: number[];
  layerAt: number[];
  signStart: number;
  verifyStart: number;
  forsAt: number;
  rootAt: number;
  stampAt: number;
  total: number;
}

export interface ProofState {
  tx: Tx;
  tl: ProofTimeline;
  t: number;
  playing: boolean;
  speed: number;
  live: boolean;
  applied: boolean;
}

/** The prototype's component state (freshState() shape). */
export interface ProtoState {
  screen: Screen;
  w: Wallet | null;
  onboarded: boolean;
  engStep: number;
  engDone: boolean;
  restoring: boolean;
  restoreText: string;
  bStage: BackupStage;
  revealed: boolean;
  seenWords: boolean;
  quiz: QuizItem[] | null;
  backedUp: boolean;
  funded: boolean;
  faucetBusy: boolean;
  deployed: boolean;
  nonce: number;
  block: number;
  bal: Balances;
  ledger: LedgerEntry[];
  sFrom: SwapSym;
  sAmt: string;
  slip: number;
  proof: ProofState | null;
  copied: boolean;
  copiedTx: boolean;
}

/** The prototype's DC props. */
export interface ProtoProps {
  startScreen?: string;
  /** Explorer tx URL prefix; anything that is not a non-blank string falls back to DEFAULT_EXPLORER. */
  explorer?: unknown;
}

export interface TokenInfo {
  name: string;
  cls: string;
  glyph: string;
  /** Display decimals. */
  d: number;
  /** USD price used by the prototype. */
  px: number;
}

export interface SerialGlyph {
  ch: string;
  /** font-size in px */
  size: number;
}

export interface HoldingView {
  sym: TokenSym;
  name: string;
  cls: string;
  glyph: string;
  mark: string;
  amt: string;
  val: string;
  zcls: '' | 'zero';
}

export interface AllocationSeg {
  cls: string;
  /** flex-grow value (percentage of total, toFixed(2)) */
  w: string;
}

export interface LedgerRowView {
  title: string;
  meta: string;
  hash: string;
  hashShort: string;
  url: string;
  seal: SealPaths;
  hasProof: boolean;
}

export interface WordView {
  n: string;
  w: string;
}

export interface QuizOptView {
  w: string;
  cls: '' | 'right' | 'wrong';
  pressed: 'true' | 'false';
}

export interface QuizItemView {
  pos: string;
  opts: QuizOptView[];
}

export interface PlanFrameView {
  i: string;
  mode: FrameMode;
  modeCls: string;
  desc: string;
}

export interface ProofPhaseView {
  name: string;
  cls: '' | 'now' | 'done';
}

export interface ProofFrameView {
  i: string;
  mode: FrameMode;
  modeCls: string;
  desc: string;
  status: '' | 'Running' | 'Done' | 'Approved';
  cls: string;
}

export interface ReceiptRow {
  k: string;
  v: string;
}

export interface ProofView {
  has: boolean;
  phases: ProofPhaseView[];
  frames: ProofFrameView[];
  dim: string;
  lit: string;
  hot: string;
  climb: string;
  stageCls: string;
  title: string;
  sub: string;
  done: boolean;
  stamped: boolean;
  receipt: ReceiptRow[];
  txHash: string;
  txShort: string;
  txUrl: string;
  block: string;
  playLabel: 'Play' | 'Pause' | 'Replay';
  slowPressed: 'true' | 'false';
}

export interface SignGate {
  signLabel: string;
  signLocked: boolean;
}

/** Everything renderVals() returns except the handler closures, in the same key order. */
export interface RenderValues {
  fibers: Fiber[];
  brand: SealPaths;
  spec: SealPaths;
  acct: SealPaths;
  acctL: SealPaths;
  specRing: string;
  pkRing: string;
  fsRing: string;
  hasWallet: boolean;
  showNav: boolean;
  addr: string;
  addrShort: string;
  serial: SerialGlyph[];
  navV: '' | 'on';
  navE: '' | 'on';
  isGenesis: boolean;
  isEngrave: boolean;
  isRestore: boolean;
  isBackup: boolean;
  isVault: boolean;
  isExchange: boolean;
  isProof: boolean;
  engStatus: string;
  engDone: boolean;
  engWorking: boolean;
  engTitleA: string;
  engTitleB: string;
  engCta: string;
  bPlate: boolean;
  bQuiz: boolean;
  bSealed: boolean;
  words: WordView[];
  plateCls: 'shown' | 'veiled';
  holdLabel: string;
  revealPressed: 'true' | 'false';
  quizLocked: boolean;
  quizItems: QuizItemView[];
  sealLocked: boolean;
  restoreText: string;
  restoreCount: string;
  restoreLocked: boolean;
  funded: boolean;
  unfunded: boolean;
  totInt: string;
  totCents: string;
  holdings: HoldingView[];
  segs: AllocationSeg[];
  compLabel: string;
  faucetLabel: string;
  faucetBusy: boolean;
  copyLabel: string;
  backupPending: boolean;
  ledger: LedgerRowView[];
  hasLedger: boolean;
  fromSym: SwapSym;
  toSym: SwapSym;
  fromCls: string;
  toCls: string;
  fromGlyph: string;
  toGlyph: string;
  fromMark: string;
  toMark: string;
  sAmt: string;
  fromBal: string;
  outAmt: string;
  outUsd: string;
  rateText: string;
  minText: string;
  feeText: string;
  planFrames: PlanFrameView[];
  frameCount: string;
  signLabel: string;
  signLocked: boolean;
  pv: ProofView;
  copyTxLabel: string;
}

// ============================================================================ constants

/** USD price of ETH/WETH used everywhere in the prototype. */
export const PX = 3412.5;
export const DEFAULT_EXPLORER = 'https://etherscan.io/tx/';
/** Seed of the prototype's demo wallet (freshState for every start screen except genesis). */
export const DEMO_SEED = '5f1c9a0e7b3d2c4f8a6e1b0d9c7f3a2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a';
export const TOKEN_ORDER: readonly TokenSym[] = ['ETH', 'WETH', 'USDC'];
export const TOKENS: Readonly<Record<TokenSym, TokenInfo>> = {
  ETH: { name: 'Ether', cls: 't-eth', glyph: 'Ξ', d: 4, px: PX },
  WETH: { name: 'Wrapped Ether', cls: 't-weth', glyph: 'Ξ', d: 4, px: PX },
  USDC: { name: 'USD Coin', cls: 't-usdc', glyph: '$', d: 2, px: 1 },
};
export const ENG_STATUS: readonly string[] = ['Drawing a 256-bit seed', 'Computing PK.root', 'Deriving your account'];
const FIBER_COLORS: readonly string[] = ['var(--l1)', 'var(--l2)', 'var(--l3)', 'var(--l4)'];
const HEX_DIGITS = '0123456789abcdef';
const WORDS =
  'anchor april arctic atom autumn balcony bamboo banner barrel beach bicycle blossom bracket brass breeze bronze cabin canal canvas canyon carbon castle cereal chalk cherry chimney cinnamon citizen clay cliff clock cloud cluster coast coconut copper coral cotton crater crystal cube curtain dawn december desert diamond dolphin dragon drift dune eagle echo elegant engine envelope era essence eternal fabric february fiber fiction flame flight flower fluid foam fog forest fossil fragile frame frost galaxy garden garlic gentle ginger glass globe glow gold gravity grid harbor harvest hawk hedgehog hollow honey hover ice icon index island ivory jaguar jazz jewel jungle kangaroo kite kitten kiwi ladder lamp lava layer legend lemon lens leopard liberty lion liquid lizard lobster lunar machine magnet mango maple marble matrix meadow melody mesh metal midnight mirror moon mountain museum mushroom mystery myth nature nest noble noodle north novel oak ocean october olive opera orange orbit orchard ostrich oval oxygen oyster ozone palace panda paper parade parrot peach pelican pepper piano pigeon pilot pioneer planet plastic poem polar pond puzzle pyramid quantum rabbit raccoon radar rail raven razor rebel recipe ribbon rocket saddle salmon satoshi scatter scene scorpion season shadow shell shrimp signal silk silver siren sketch sleeve smoke snake solar sphere spider spirit sponge square squirrel stadium sugar summit sunset supreme surface swallow swan symbol talent tent thunder tiger timber tomato tongue tornado tortoise tower trophy tunnel turtle twin umbrella universe urban valley vapor velvet venture vessel vintage violin vivid volcano voyage wagon walnut wave wealth whale wheat whisper window winter wisdom wolf wonder wool zebra zero zone';

// ============================================================================ caches

const sealCache = new Map<string, SealPaths>();
const tokenMarkCache = new Map<string, string>();
const treeCache = new Map<string, TreeGeometry>();
let wordlistCache: string[] | null = null;
let fiberCache: Fiber[] | null = null;
let specPkCache: string | null = null;

/** Drops every memoised result (tests, HMR). Results are deterministic, so this never changes output. */
export function clearHelperCaches(): void {
  sealCache.clear();
  tokenMarkCache.clear();
  treeCache.clear();
  wordlistCache = null;
  fiberCache = null;
  specPkCache = null;
}

// ============================================================================ deterministic bytes

/** 32-bit string hash (murmur-style mix). Prototype stand-in for SHA-256, not cryptographic. */
export function h32(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 PRNG seeded with h32(str). */
export function rng(str: string): Rng {
  let a = h32(str);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n pseudo-random bytes as 2n lowercase hex chars (no 0x). */
export function hex(str: string, n: number): string {
  const r = rng(str);
  let o = '';
  for (let i = 0; i < n * 2; i++) o += HEX_DIGITS.charAt((r() * 16) | 0);
  return o;
}

// ============================================================================ formatting

/** en-US grouping with exactly d fraction digits; null/undefined/NaN/0 print as 0. */
export function fmt(n: number | null | undefined, d: number): string {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** 0x1234…abcd (first 6 chars, ellipsis, last 4); '' for empty input. */
export function short(a: string | null | undefined): string {
  return a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
}

/** Explorer tx URL prefix from the DC `explorer` prop. */
export function explorer(e?: unknown): string {
  return typeof e === 'string' && e.trim() ? e.trim() : DEFAULT_EXPLORER;
}

// ============================================================================ demo wallet (fake)

/** The prototype's 262-word list (NOT BIP-39). */
export function wordlist(): string[] {
  if (!wordlistCache) {
    wordlistCache = WORDS.split(' ');
  }
  return wordlistCache;
}

/** 24 distinct words drawn from wordlist() with rng('bip39|' + seed) (NOT BIP-39). */
export function mnemonic(seed: string): string[] {
  const wl = wordlist();
  const r = rng('bip39|' + seed);
  const out: string[] = [];
  while (out.length < 24) {
    const w = wl[(r() * wl.length) | 0] as string;
    if (out.indexOf(w) < 0) out.push(w);
  }
  return out;
}

/** Fake wallet: pk = 32 bytes hex, addr = 0x + 20 bytes hex, both derived from the seed string. */
export function deriveWallet(seed: string, words?: string[] | null): Wallet {
  return {
    seed,
    words: words || mnemonic(seed),
    pk: hex('pk|' + seed, 32),
    addr: '0x' + hex('addr|' + seed, 20),
  };
}

// ============================================================================ SVG geometry

/** Full circle as two arcs: M R 0 A ... -R 0 A ... R 0 (identical in seal, tokenMark and tree). */
function circ(R: number): string {
  return 'M' + R + ' 0A' + R + ' ' + R + ' 0 1 1 ' + (-R) + ' 0A' + R + ' ' + R + ' 0 1 1 ' + R + ' 0';
}

/**
 * The seal: a guilloché rosette engraved from the seed (normally 'acct|' + pk).
 * lite = true is the low-detail variant used at 30-40px (mseal); coordinates are
 * rounded to integers there and to 0.1 in the full variant.
 */
export function seal(seed: string, lite?: boolean): SealPaths {
  const key = seed + (lite ? '|L' : '|F');
  const hit = sealCache.get(key);
  if (hit) return hit;
  const r = rng('seal|' + seed);
  const pick = <T>(a: readonly T[]): T => a[(r() * a.length) | 0] as T;
  const k = lite ? 1 : 10;
  const f = (v: number): string => String(Math.round(v * k) / k);
  const TAU = Math.PI * 2;
  const ring = (R: number, amp: number, m: number, ph: number, amp2: number, m2: number, ph2: number, n: number): string => {
    let d = '';
    for (let i = 0; i <= n; i++) {
      const th = (i / n) * TAU;
      const rad = R + amp * Math.sin(m * th + ph) + amp2 * Math.sin(m2 * th + ph2);
      d += (i ? ' ' : 'M') + f(rad * Math.cos(th)) + ' ' + f(rad * Math.sin(th));
    }
    return d + 'Z';
  };
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const m = pick([18, 20, 22, 24, 26, 28]);
  const J = lite ? 4 : 9;
  const w2 = pick([3, 4, 5, 6]);
  const wph = r() * TAU;
  let braidA = '';
  let braidB = '';
  for (let j = 0; j < J; j++) {
    const R = 62 + (j * 11) / (J - 1);
    braidA += ring(R, 3.4, m, 0, 1.1, w2, wph, m * (lite ? 8 : 12));
    braidB += ring(R, 3.4, m, Math.PI, 1.1, w2, wph, m * (lite ? 8 : 12));
  }
  const P = pick([7, 9, 11, 13]);
  const q = pick([2, 3, 4].filter((x) => gcd(P, x) === 1 && x / P <= 0.3));
  const rr = q / P;
  const C = lite ? 3 : 7;
  const d0 = 1.05 + r() * 0.25;
  let ros = '';
  for (let c = 0; c < C; c++) {
    const d = rr * (d0 + c * (lite ? 0.14 : 0.055));
    const S = 57 / (1 - rr + d);
    const n = (P - q) * (lite ? 12 : 28) + q * 8;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * TAU * q;
      const x = (1 - rr) * Math.cos(t) + d * Math.cos(((1 - rr) / rr) * t);
      const y = (1 - rr) * Math.sin(t) - d * Math.sin(((1 - rr) / rr) * t);
      ros += (i ? ' ' : 'M') + f(x * S) + ' ' + f(y * S);
    }
  }
  const m3 = pick([5, 6, 7, 8]);
  const J3 = lite ? 4 : 13;
  const tw = 0.1 + r() * 0.12;
  let inner = '';
  for (let j = 0; j < J3; j++) {
    const R = 9 + (j * 35) / (J3 - 1);
    inner += ring(R, 0.6 + (4.6 * j) / (J3 - 1), m3, j * tw * (lite ? 2.6 : 1), 0, 1, 0, m3 * (lite ? 10 : 30));
  }
  const rules = lite ? circ(97) : circ(99.4) + circ(97.9) + circ(80);
  const ringPath = 'M0 -88.5A88.5 88.5 0 1 1 0 88.5A88.5 88.5 0 1 1 0 -88.5';
  const out: SealPaths = { braidA, braidB, ros, inner, rules, ringPath, ringLen: 2 * Math.PI * 88.5 };
  sealCache.set(key, out);
  return out;
}

/** Engraved token medallion (viewBox="-20 -20 40 40"): braided ring; WETH gets a second rim (wrapped). */
export function tokenMark(sym: string): string {
  const key = 'tok|' + sym;
  const hit = tokenMarkCache.get(key);
  if (hit) return hit;
  const TAU = Math.PI * 2;
  const f = (v: number): string => String(Math.round(v * 100) / 100);
  const m = sym === 'USDC' ? 10 : 12;
  const ring = (R: number, ph: number): string => {
    let d = '';
    const n = m * 10;
    for (let i = 0; i <= n; i++) {
      const th = (i / n) * TAU;
      const rad = R + 1.1 * Math.sin(m * th + ph);
      d += (i ? ' ' : 'M') + f(rad * Math.cos(th)) + ' ' + f(rad * Math.sin(th));
    }
    return d + 'Z';
  };
  let d = ring(15.4, 0) + ring(15.4, Math.PI) + circ(18.6);
  if (sym === 'WETH') d += circ(20.2) + circ(11.6);
  tokenMarkCache.set(key, d);
  return d;
}

/** SLH-DSA-SHA2-128s hypertree drawn inside the seal: k = 14 FORS trees, d = 7 layers. */
export function tree(seed: string): TreeGeometry {
  const key = 'tree|' + seed;
  const hit = treeCache.get(key);
  if (hit) return hit;
  const r = rng(key);
  const TAU = Math.PI * 2;
  const f = (v: number): string => String(Math.round(v * 10) / 10);
  const dot = (x: number, y: number, s: number): string =>
    'M' + f(x + s) + ' ' + f(y) + 'a' + s + ' ' + s + ' 0 1 0 ' + (-2 * s) + ' 0a' + s + ' ' + s + ' 0 1 0 ' + (2 * s) + ' 0';
  const ring = (R: number, amp: number, m: number, ph: number, n: number): string => {
    let d = '';
    for (let i = 0; i <= n; i++) {
      const th = (i / n) * TAU;
      const rad = R + amp * Math.sin(m * th + ph);
      d += (i ? ' ' : 'M') + f(rad * Math.cos(th)) + ' ' + f(rad * Math.sin(th));
    }
    return d + 'Z';
  };
  const spokes: string[] = [];
  for (let i = 0; i < 14; i++) {
    const th = (i / 14) * TAU - Math.PI / 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    spokes.push('M' + f(5 * c) + ' ' + f(5 * s) + 'L' + f(16.6 * c) + ' ' + f(16.6 * s) + dot(18.2 * c, 18.2 * s, 1.6));
  }
  const radii: number[] = [];
  const layers: string[] = [];
  for (let j = 0; j < 7; j++) {
    const R = 26 + j * 4.9;
    const m = 12 + j * 4;
    radii.push(R);
    layers.push(ring(R, 0.8, m, 0, m * 10) + ring(R, 0.8, m, Math.PI, m * 10));
  }
  let th = -Math.PI / 2 + (r() - 0.5) * 1.2;
  let pr = 21.5;
  const climb: string[] = [];
  radii.concat([62]).forEach((R) => {
    const th2 = th + (r() - 0.5) * 0.42;
    const ax = pr * Math.cos(th);
    const ay = pr * Math.sin(th);
    const bx = R * Math.cos(th2);
    const by = R * Math.sin(th2);
    climb.push('M' + f(ax) + ' ' + f(ay) + 'L' + f(bx) + ' ' + f(by) + dot(bx, by, 1.3));
    th = th2;
    pr = R;
  });
  const out: TreeGeometry = { spokes, fors: circ(21.5), layers, climb };
  treeCache.set(key, out);
  return out;
}

/** 26 background fibres hugging the left/right 4.5% edges (style: left/top %, color, rotate, scale). */
export function fibers(): Fiber[] {
  if (!fiberCache) {
    const r = rng('uv-fibers');
    const cs = FIBER_COLORS;
    fiberCache = Array.from(
      { length: 26 },
      (): Fiber => ({
        x: (r() < 0.5 ? r() * 4.5 : 95.5 + r() * 4.5).toFixed(2),
        y: (r() * 100).toFixed(2),
        r: (r() * 360) | 0,
        s: (0.6 + r() * 0.9).toFixed(2),
        c: cs[(r() * 4) | 0] as string,
      }),
    );
  }
  return fiberCache;
}

/** Public-key ring text: 'PK 0x<pk>  ·  ' repeated 6 times (set along SealPaths.ringPath). */
export function ringText(pk: string): string {
  let t = '';
  for (let i = 0; i < 6; i++) t += 'PK 0x' + pk + '  ·  ';
  return t;
}

/** font-size (px, toFixed(3)) that fits the ring text once around the ring (0.605em monospace advance). */
export function ringFontSize(ringLen: number, ring: string): string {
  return (ringLen / (ring.length * 0.605)).toFixed(3);
}

/** hex('specimen-pk', 32): the placeholder key shown on the genesis specimen seal. */
export function specimenPk(): string {
  if (!specPkCache) specPkCache = hex('specimen-pk', 32);
  return specPkCache;
}

/** "Nº" serial under the seal: ABCD·WXYZ from the address, growing font sizes, the dot at 22px. */
export function serialGlyphs(addr: string): SerialGlyph[] {
  return (addr.slice(2, 6) + '·' + addr.slice(-4))
    .toUpperCase()
    .split('')
    .map((ch, i) => ({ ch, size: ch === '·' ? 22 : 16 + i * 2 }));
}

// ============================================================================ portfolio views

export function balanceTotal(bal: Balances): number {
  return (bal.ETH + bal.WETH) * PX + bal.USDC;
}

export function holdingsView(bal: Balances): HoldingView[] {
  return TOKEN_ORDER.map(
    (sym): HoldingView => ({
      sym,
      name: TOKENS[sym].name,
      cls: TOKENS[sym].cls,
      glyph: TOKENS[sym].glyph,
      mark: tokenMark(sym),
      amt: fmt(bal[sym], TOKENS[sym].d),
      val: '$' + fmt(bal[sym] * TOKENS[sym].px, 2),
      zcls: bal[sym] > 0 ? '' : 'zero',
    }),
  );
}

/** Allocation bar segments (only tokens above 0.2% of the total). */
export function allocationSegs(bal: Balances, tot: number = balanceTotal(bal)): AllocationSeg[] {
  return TOKEN_ORDER.filter((sym) => tot > 0 && (bal[sym] * TOKENS[sym].px) / tot > 0.002).map((sym) => ({
    cls: TOKENS[sym].cls,
    w: (((bal[sym] * TOKENS[sym].px) / tot) * 100).toFixed(2),
  }));
}

/** aria-label of the allocation bar. */
export function allocationLabel(bal: Balances, tot: number = balanceTotal(bal)): string {
  return (
    'Allocation: ' +
    TOKEN_ORDER.filter((sym) => bal[sym] > 0)
      .map((sym) => sym + ' ' + (tot > 0 ? (((bal[sym] * TOKENS[sym].px) / tot) * 100).toFixed(1) : '0') + '%')
      .join(', ')
  );
}

/** One Activity row; explorerBase is the resolved prefix (explorer(props.explorer)). */
export function ledgerRowView(l: LedgerEntry, explorerBase: string): LedgerRowView {
  return {
    title: l.title,
    meta: l.meta,
    hash: '0x' + l.hash,
    hashShort: '0x' + l.hash.slice(0, 6) + '…' + l.hash.slice(-4),
    url: explorerBase + '0x' + l.hash,
    seal: seal(l.sealSeed, true),
    hasProof: !!l.tx,
  };
}

export function faucetEntry(block: number): LedgerEntry {
  return { id: 'f' + block, title: 'Received 1 ETH and 5,000 USDC', meta: 'Faucet · block ' + fmt(block, 0), hash: hex('faucet-tx|' + block, 32), sealSeed: 'faucet|' + block, tx: null };
}

// ============================================================================ onboarding views

/** Engrave screen status line; engStep is 0..3 (3 = done). */
export function engStatusText(engStep: number): string {
  return ENG_STATUS[Math.min(2, engStep)] as string;
}

export function wordsView(words: readonly string[]): WordView[] {
  return words.map((x, i) => ({ n: String(i + 1).padStart(2, '0'), w: x }));
}

/** Backup check: 3 distinct positions, each with the answer + 3 decoys, shuffled. */
export function makeQuiz(w: Pick<Wallet, 'seed' | 'words'>, now: number = Date.now()): QuizItem[] {
  const r = rng('quiz|' + w.seed + '|' + now);
  const pos: number[] = [];
  while (pos.length < 3) {
    const p = (r() * 24) | 0;
    if (pos.indexOf(p) < 0) pos.push(p);
  }
  pos.sort((a, b) => a - b);
  const wl = wordlist();
  return pos.map((p): QuizItem => {
    const ans = w.words[p] as string;
    const opts = [ans];
    while (opts.length < 4) {
      const x = wl[(r() * wl.length) | 0] as string;
      if (opts.indexOf(x) < 0) opts.push(x);
    }
    for (let i = opts.length - 1; i > 0; i--) {
      const j = (r() * (i + 1)) | 0;
      const t = opts[i] as string;
      opts[i] = opts[j] as string;
      opts[j] = t;
    }
    return { pos: p, ans, opts, picked: null, ok: false };
  });
}

export function quizItemsView(quiz: readonly QuizItem[]): QuizItemView[] {
  return quiz.map((q) => ({
    pos: String(q.pos + 1),
    opts: q.opts.map(
      (o): QuizOptView => ({
        w: o,
        cls: q.picked === o ? (o === q.ans ? 'right' : 'wrong') : '',
        pressed: q.picked === o ? 'true' : 'false',
      }),
    ),
  }));
}

export function isQuizDone(quiz: readonly QuizItem[]): boolean {
  return quiz.length > 0 && quiz.every((q) => q.ok);
}

/** Restore textarea -> normalised word list (trim, lowercase, split on whitespace). */
export function restoreWords(text: string): string[] {
  return text.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// ============================================================================ exchange (simulated)

/** Constant-product quote against a fixed 1850 WETH / 1850*PX USDC pool with a 0.05% fee. */
export function quote(from: SwapSym, amt: number, slip: number): Quote | null {
  const RW = 1850;
  const RU = RW * PX;
  const FEE = 0.0005;
  if (!(amt > 0)) return null;
  const inF = amt * (1 - FEE);
  const out = from === 'USDC' ? (inF * RW) / (RU + inF) : (inF * RU) / (RW + inF);
  return {
    out,
    minOut: out * (1 - slip / 100),
    rate: from === 'USDC' ? amt / out : out / amt,
    usdOut: from === 'USDC' ? out * PX : out,
  };
}

/** Frame plan + gas estimate: 7,856-byte signature as calldata; VERIFY ~ 36,118 + 194 per hash. */
export function plan(from: SwapSym, amt: number, deployed: boolean): Plan {
  const to = from === 'USDC' ? 'WETH' : 'USDC';
  const a = amt > 0 ? fmt(amt, from === 'USDC' ? 2 : 4) : '0';
  const fr: PlanFrame[] = [];
  if (!deployed) fr.push({ mode: 'DEFAULT', short: 'Deploy account', limit: 200000, used: 118204 });
  fr.push({ mode: 'VERIFY', short: 'Check signature', limit: 600000, used: 444190 });
  fr.push({ mode: 'SENDER', short: 'Approve ' + a + ' ' + from, limit: 60000, used: 46284 });
  fr.push({ mode: 'SENDER', short: 'Swap to ' + to, limit: 180000, used: 118437 });
  const calldata = 16 * (7856 + 420) + (deployed ? 0 : 16 * 96);
  const used = 15000 + calldata + fr.reduce((sum, x) => sum + x.used, 0);
  const feeEth = used * 0.6e-9;
  return { frames: fr, used, feeEth, feeUsd: feeEth * 3412.5 };
}

export interface TxInput {
  w: Pick<Wallet, 'seed'>;
  sAmt: string;
  sFrom: SwapSym;
  slip: number;
  deployed: boolean;
  nonce: number;
  block: number;
}

/** Simulated signed transaction; `now` replaces the prototype's Date.now() in the tx id. */
export function makeTx(s: TxInput, now: number = Date.now()): Tx {
  const amt = parseFloat(s.sAmt);
  const from = s.sFrom;
  const to: SwapSym = from === 'USDC' ? 'WETH' : 'USDC';
  const q = quote(from, amt, s.slip);
  const pl = plan(from, amt, s.deployed);
  const id = hex('tx|' + s.w.seed + '|' + s.nonce + '|' + amt + from + '|' + now, 32);
  const r = rng('ops|' + id);
  const layerOps: number[] = [];
  for (let j = 0; j < 7; j++) layerOps.push(255 + ((r() * 36) | 0));
  const ops = 1 + 14 * 13 + 1 + layerOps.reduce((a, b) => a + b, 0);
  const frames = pl.frames.map(
    (x): PlanFrame => ({
      ...x,
      used: x.mode === 'VERIFY' ? 36118 + 194 * ops + 2400 : Math.round(x.used * (0.985 + r() * 0.03)),
    }),
  );
  const calldata = 16 * (7856 + 420) + (s.deployed ? 0 : 16 * 96);
  const used = 15000 + calldata + frames.reduce((sum, x) => sum + x.used, 0);
  const feeEth = used * 0.6e-9;
  return {
    id,
    from,
    to,
    amt,
    out: q ? q.out : 0,
    frames,
    used,
    feeEth,
    feeUsd: feeEth * 3412.5,
    deploy: !s.deployed,
    layerOps,
    ops,
    block: s.block + 2 + ((r() * 3) | 0),
  };
}

export interface SwapPatch {
  bal: Balances;
  deployed: boolean;
  nonce: number;
  block: number;
  ledger: LedgerEntry[];
}

/** State patch after a swap settles (balances, nonce, block, new ledger row first). */
export function applySwap(tx: Tx, s: Pick<ProtoState, 'bal' | 'nonce' | 'ledger'>): SwapPatch {
  const bal: Balances = { ...s.bal };
  bal[tx.from] = Math.max(0, bal[tx.from] - tx.amt);
  bal[tx.to] = bal[tx.to] + tx.out;
  bal.ETH = Math.max(0, bal.ETH - tx.feeEth);
  const dIn = tx.from === 'USDC' ? 2 : 4;
  const dOut = tx.to === 'USDC' ? 2 : 4;
  const entry: LedgerEntry = {
    id: tx.id,
    title: 'Swapped ' + fmt(tx.amt, dIn) + ' ' + tx.from + ' → ' + fmt(tx.out, dOut) + ' ' + tx.to,
    meta: tx.frames.length + ' frames · block ' + fmt(tx.block, 0),
    hash: tx.id,
    sealSeed: 'tx|' + tx.id,
    tx,
  };
  return { bal, deployed: true, nonce: s.nonce + 1, block: tx.block, ledger: [entry, ...s.ledger] };
}

/** Exchange "Sign" button label/lock, in the prototype's precedence order. */
export function signGate(s: Pick<ProtoState, 'funded' | 'bal' | 'sFrom'>, amt: number, pl: Pick<Plan, 'feeEth'>): SignGate {
  const bal = s.bal;
  const from = s.sFrom;
  let signLabel = 'Sign';
  let signLocked = false;
  if (!s.funded) {
    signLabel = 'Get devnet funds first';
    signLocked = true;
  } else if (!(amt > 0)) {
    signLabel = 'Enter an amount';
    signLocked = true;
  } else if (amt > bal[from] + 1e-9) {
    signLabel = 'Not enough ' + from;
    signLocked = true;
  } else if (bal.ETH < pl.feeEth) {
    signLabel = 'Not enough ETH for gas';
    signLocked = true;
  }
  return { signLabel, signLocked };
}

export function planFramesView(pl: Pick<Plan, 'frames'>): PlanFrameView[] {
  return pl.frames.map((f, i) => ({ i: String(i), mode: f.mode, modeCls: 'm-' + f.mode.toLowerCase(), desc: f.short }));
}

/** onAmt handler core: strip commas and anything but digits/dots, keep only the first dot. */
export function sanitizeAmount(value: unknown): string {
  let v = String(value).replace(/,/g, '').replace(/[^0-9.]/g, '');
  const parts = v.split('.');
  if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
  return v;
}

/** setMax handler core: floor the balance to 2 (USDC) or 4 (WETH) decimals. */
export function maxAmount(from: SwapSym, bal: Balances): string {
  return from === 'USDC' ? String(Math.floor(bal.USDC * 100) / 100) : String(Math.floor(bal.WETH * 10000) / 10000);
}

/** flip handler core: the new sAmt after swapping direction (`to` is the old receive side). */
export function flipAmount(to: SwapSym, q: Quote | null): string {
  return q ? (to === 'USDC' ? q.out.toFixed(2) : q.out.toFixed(4)) : '';
}

// ============================================================================ proof animation

/** Timeline: compose -> sign -> verify (FORS, 7 layers, root) -> execute -> settle, in ms. */
export function buildProof(tx: Pick<Tx, 'deploy' | 'frames' | 'layerOps'>): ProofTimeline {
  // `end` and the scalar fields are filled in below, in the prototype's order (keeps key order identical)
  const ph = [
    { name: 'Compose', title: 'Composing' },
    { name: 'Sign', title: 'Signing' },
    { name: 'Verify', title: 'Verifying' },
    { name: 'Execute', title: 'Executing' },
    { name: 'Settle', title: 'Settled' },
  ] as ProofPhase[];
  const tl = { ph, fAppear: [], fRun: [], fDone: [], units: [], spokeAt: [], layerStart: [], layerAt: [] } as unknown as ProofTimeline;
  const vi = tx.deploy ? 1 : 0;
  let t = 200;
  tx.frames.forEach((_f, i) => {
    t += 320;
    tl.fAppear[i] = t;
  });
  ph[0]!.end = t + 500;
  t = ph[0]!.end;
  tl.signStart = t;
  ph[1]!.end = t + 2200;
  t = ph[1]!.end;
  tl.verifyStart = t;
  if (tx.deploy) {
    tl.fRun[0] = t + 100;
    t += 600;
    tl.fDone[0] = t;
  }
  tl.fRun[vi] = t + 100;
  tl.units.push({ t0: t, t1: t + 250, n: 1 });
  t += 250;
  for (let i = 0; i < 14; i++) {
    tl.units.push({ t0: t, t1: t + 75, n: 13 });
    t += 75;
    tl.spokeAt.push(t);
  }
  tl.units.push({ t0: t, t1: t + 200, n: 1 });
  t += 200;
  tl.forsAt = t;
  for (let j = 0; j < 7; j++) {
    tl.layerStart.push(t);
    tl.units.push({ t0: t, t1: t + 430, n: tx.layerOps[j] as number });
    t += 430;
    tl.layerAt.push(t);
  }
  t += 450;
  tl.rootAt = t;
  t += 350;
  tl.fDone[vi] = t;
  ph[2]!.end = t + 200;
  t = ph[2]!.end;
  for (let i = vi + 1; i < tx.frames.length; i++) {
    tl.fRun[i] = t + 100;
    t += 700;
    tl.fDone[i] = t;
  }
  ph[3]!.end = t + 200;
  t = ph[3]!.end;
  tl.stampAt = t + 300;
  tl.total = t + 1100;
  ph[4]!.end = tl.total + 1;
  return tl;
}

/**
 * Proof screen view at time p.t: phase rail, frame list, and the hypertree split into
 * dim / lit / hot / climb SVG path strings (tree(seedKey) drawn in viewBox -100 -100 200 200).
 * seedKey is the account seal key ('acct|' + pk, or 'specimen|slh-dsa' without a wallet).
 */
export function proofView(p: ProofState | null | undefined, seedKey: string, explorerProp?: unknown): ProofView {
  const empty: ProofView = { has: false, phases: [], frames: [], dim: '', lit: '', hot: '', climb: '', stageCls: '', title: '', sub: '', done: false, stamped: false, receipt: [], txHash: '', txShort: '', txUrl: '', block: '', playLabel: 'Play', slowPressed: 'false' };
  if (!p) return empty;
  const { tx, tl } = p;
  const now = p.t;
  const done = now >= tl.total;
  let pi = 4;
  for (let i = 0; i < 5; i++) {
    if (now < tl.ph[i]!.end) {
      pi = i;
      break;
    }
  }
  const phases = tl.ph.map((x, i): ProofPhaseView => ({ name: x.name, cls: done || i < pi ? 'done' : i === pi ? 'now' : '' }));
  const frames = tx.frames.map((f, i): ProofFrameView => {
    const ap = now >= (tl.fAppear[i] as number);
    const fRun = tl.fRun[i];
    const fDone = tl.fDone[i];
    const run = fRun != null && now >= fRun;
    const fin = fDone != null && now >= fDone;
    return {
      i: String(i),
      mode: f.mode,
      modeCls: 'm-' + f.mode.toLowerCase(),
      desc: f.short,
      status: fin ? (f.mode === 'VERIFY' ? 'Approved' : 'Done') : run ? 'Running' : '',
      cls: (ap ? 'in' : '') + (run && !fin ? ' run' : '') + (fin ? ' fin' : ''),
    };
  });
  const g = tree(seedKey);
  let dim = '';
  let lit = '';
  let hot = '';
  let climb = '';
  g.spokes.forEach((d, i) => {
    const at = tl.spokeAt[i] as number;
    if (now >= at) lit += d;
    else if (now >= at - 75 && now >= tl.verifyStart) hot += d;
    else dim += d;
  });
  if (now >= tl.forsAt) lit += g.fors;
  else dim += g.fors;
  g.layers.forEach((d, j) => {
    if (now >= (tl.layerAt[j] as number)) lit += d;
    else if (now >= (tl.layerStart[j] as number)) hot += d;
    else dim += d;
  });
  g.climb.forEach((d, j) => {
    if ((j < 7 && now >= (tl.layerAt[j] as number)) || (j === 7 && now >= tl.rootAt)) climb += d;
  });
  let hashes = 0;
  tl.units.forEach((u) => {
    if (now >= u.t1) hashes += u.n;
    else if (now > u.t0) hashes += Math.floor((u.n * (now - u.t0)) / (u.t1 - u.t0));
  });
  const locked = now >= tl.rootAt;
  const signing = now >= tl.signStart && now < tl.verifyStart;
  const subs = [
    tx.frames.length + ' frames · 1 signature',
    'SLH-DSA-SHA2-128s · 7,856 bytes',
    locked ? 'Root matches · ' + fmt(hashes, 0) + ' hashes' : fmt(hashes, 0) + ' hashes',
    'Running as your account',
    'Block ' + fmt(tx.block, 0),
  ];
  const dIn = tx.from === 'USDC' ? 2 : 4;
  const dOut = tx.to === 'USDC' ? 2 : 4;
  return {
    has: true,
    phases,
    frames,
    dim,
    lit,
    hot,
    climb,
    stageCls: (signing ? ' signing' : '') + (locked ? ' locked' : ''),
    title: done ? 'Verified' : tl.ph[pi]!.title,
    sub: subs[pi] as string,
    done,
    stamped: now >= tl.stampAt,
    receipt: [
      { k: 'Result', v: '−' + fmt(tx.amt, dIn) + ' ' + tx.from + ' · +' + fmt(tx.out, dOut) + ' ' + tx.to },
      { k: 'Block', v: fmt(tx.block, 0) },
      { k: 'Gas', v: fmt(tx.used, 0) },
      { k: 'Fee', v: '$' + fmt(tx.feeUsd, 2) },
    ],
    txHash: '0x' + tx.id,
    txShort: '0x' + tx.id.slice(0, 8) + '…' + tx.id.slice(-6),
    txUrl: explorer(explorerProp) + '0x' + tx.id,
    block: fmt(tx.block, 0),
    playLabel: done ? 'Replay' : p.playing ? 'Pause' : 'Play',
    slowPressed: p.speed < 1 ? 'true' : 'false',
  };
}

// ============================================================================ state + render values

/** Initial state per DC `startScreen` prop ('genesis' | 'backup' | 'portfolio' | 'vault' | 'exchange' | 'proof'). */
export function freshState(start?: string | null, now: number = Date.now()): ProtoState {
  const base: ProtoState = {
    screen: 'genesis',
    w: null,
    onboarded: false,
    engStep: 0,
    engDone: false,
    restoring: false,
    restoreText: '',
    bStage: 'plate',
    revealed: false,
    seenWords: false,
    quiz: null,
    backedUp: false,
    funded: false,
    faucetBusy: false,
    deployed: false,
    nonce: 0,
    block: 1204816,
    bal: { ETH: 0, WETH: 0, USDC: 0 },
    ledger: [],
    sFrom: 'USDC',
    sAmt: '1000',
    slip: 0.5,
    proof: null,
    copied: false,
    copiedTx: false,
  };
  if (start === 'genesis' || !start) return base;
  const w = deriveWallet(DEMO_SEED);
  if (start === 'backup') return { ...base, w, screen: 'backup', engStep: 3, engDone: true };
  const funded = {
    ...base,
    w,
    onboarded: true,
    backedUp: true,
    funded: true,
    bal: { ETH: 1, WETH: 0, USDC: 5000 },
    block: 1204818,
    ledger: [faucetEntry(1204818)],
  };
  if (start === 'vault' || start === 'portfolio') return { ...funded, screen: 'vault' };
  if (start === 'exchange') return { ...funded, screen: 'exchange' };
  if (start === 'proof') {
    const st = { ...funded, screen: 'proof' as const };
    const tx = makeTx(st, now);
    return { ...st, proof: { tx, tl: buildProof(tx), t: 0, playing: true, speed: 1, live: true, applied: false } };
  }
  return base;
}

/** The data half of renderVals(): every binding the template reads, minus handlers. */
export function renderValues(s: ProtoState, props: ProtoProps = {}): RenderValues {
  const w = s.w;
  const scr = s.screen;
  const exp = explorer(props.explorer);

  const brand = seal('quantum-smart-wallet', true);
  const spec = seal('specimen|slh-dsa', false);
  const acctKey = w ? 'acct|' + w.pk : 'specimen|slh-dsa';
  const acct = seal(acctKey, false);
  const acctL = w ? seal(acctKey, true) : brand;
  const specPk = specimenPk();
  const specRing = ringText(specPk);
  const pkRing = ringText(w ? w.pk : specPk);
  const fsRing = ringFontSize(acct.ringLen, pkRing);

  const bal = s.bal;
  const tot = balanceTotal(bal);
  const totParts = fmt(tot, 2).split('.');
  const holdings = holdingsView(bal);
  const segs = allocationSegs(bal, tot);
  const compLabel = allocationLabel(bal, tot);
  const serial = w ? serialGlyphs(w.addr) : [];
  const ledger = s.ledger.map((l) => ledgerRowView(l, exp));

  const engStatus = engStatusText(s.engStep);

  const words = w ? wordsView(w.words) : [];
  const quiz = s.quiz || [];
  const quizItems = quizItemsView(quiz);
  const quizDone = isQuizDone(quiz);

  const rWords = restoreWords(s.restoreText);

  const from = s.sFrom;
  const to: SwapSym = from === 'USDC' ? 'WETH' : 'USDC';
  const amt = parseFloat(s.sAmt);
  const q = quote(from, amt, s.slip);
  const pl = plan(from, amt, s.deployed);
  const { signLabel, signLocked } = signGate(s, amt, pl);
  const dTo = TOKENS[to].d;
  const planFrames = planFramesView(pl);

  const pv = proofView(s.proof, acctKey, props.explorer);
  const onb = s.onboarded;

  return {
    fibers: fibers(),
    brand,
    spec,
    acct,
    acctL,
    specRing,
    pkRing,
    fsRing,
    hasWallet: !!w && onb,
    showNav: onb,
    addr: w ? w.addr : '',
    addrShort: w ? short(w.addr) : '',
    serial,
    navV: scr === 'vault' ? 'on' : '',
    navE: scr === 'exchange' ? 'on' : '',

    isGenesis: scr === 'genesis',
    isEngrave: scr === 'engrave',
    isRestore: scr === 'restore',
    isBackup: scr === 'backup',
    isVault: scr === 'vault',
    isExchange: scr === 'exchange',
    isProof: scr === 'proof' && pv.has,

    engStatus,
    engDone: s.engDone,
    engWorking: !s.engDone,
    engTitleA: s.engDone ? 'Your' : 'Engraving',
    engTitleB: s.engDone ? 'seal' : 'your seal',
    engCta: s.restoring ? 'Continue' : 'Back up',

    bPlate: s.bStage === 'plate',
    bQuiz: s.bStage === 'quiz',
    bSealed: s.bStage === 'sealed',
    words,
    plateCls: s.revealed ? 'shown' : 'veiled',
    holdLabel: s.revealed ? 'Release to hide' : 'Hold to reveal',
    revealPressed: s.revealed ? 'true' : 'false',
    quizLocked: !s.seenWords,
    quizItems,
    sealLocked: !quizDone,

    restoreText: s.restoreText,
    restoreCount: String(rWords.length),
    restoreLocked: rWords.length !== 24,

    funded: s.funded,
    unfunded: !s.funded,
    totInt: totParts[0] as string,
    totCents: totParts[1] as string,
    holdings,
    segs,
    compLabel,
    faucetLabel: s.faucetBusy ? 'Dripping…' : 'Get devnet funds',
    faucetBusy: s.faucetBusy,
    copyLabel: s.copied ? 'Copied' : 'Copy address',
    backupPending: !s.backedUp && !!w,
    ledger,
    hasLedger: ledger.length > 0,

    fromSym: from,
    toSym: to,
    fromCls: TOKENS[from].cls,
    toCls: TOKENS[to].cls,
    fromGlyph: TOKENS[from].glyph,
    toGlyph: TOKENS[to].glyph,
    fromMark: tokenMark(from),
    toMark: tokenMark(to),
    sAmt: s.sAmt,
    fromBal: fmt(bal[from], TOKENS[from].d),
    outAmt: q ? fmt(q.out, dTo) : '0',
    outUsd: q ? '≈ $' + fmt(q.usdOut, 2) : '',
    rateText: '1 WETH = ' + fmt(q ? q.rate : PX, 2) + ' USDC',
    minText: q ? fmt(q.minOut, dTo) + ' ' + to : '—',
    feeText: '$' + fmt(pl.feeUsd, 2),
    planFrames,
    frameCount: String(pl.frames.length),
    signLabel,
    signLocked,

    pv,
    copyTxLabel: s.copiedTx ? 'Copied' : 'Copy hash',
  };
}
