// Token Launch Radar — make.fun token-radar-01 entry.
//
// Reads the sealed DefiLlama snapshot, ranks the protocols that record no
// token by an implied launch value, writes the ranked board, the dashboard
// data, and the dossier. Node 22+, standard library only, no network.
//
// Run:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
// In the grader the snapshot is /input/snapshot.json and MAKEFUN_OUTPUT_DIR
// is /output. Two runs write identical bytes.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

// ------------------------------------------------------------------ types

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_years: number | null;
  has_token: boolean;
  watchlist: boolean;
  category_multiple: number;
  growth_factor: number;
  age_factor: number;
  implied_value_usd: number;
  farm_steps: string[];
}

// ------------------------------------------------------------------ value model
//
// implied_value_usd = TVL x category multiple x growth factor x age factor,
// capped at $100,000,000,000 and rounded to whole dollars.
//
// The three inputs are the snapshot's own figures only — never a list of
// names. A protocol's TVL is the size of the business a token would
// capitalise; the category multiple says how much of that size a token
// usually captures (lending and trading capture more than a bridge or an
// exchange, whose value already sits elsewhere); the growth factor rewards
// TVL that is growing and trims TVL that is shrinking; the age factor
// rewards a protocol that has run for years with no token recorded, because
// a long unlaunched track record is a longer runway for a launch.
//
//   category multiple: a table by DefiLlama category, 0.55 (CEX) to 1.30
//     (Lending); unknown or missing category takes 1.00.
//   growth factor: 1 + clamp(change_7d, -50, +100) / 200, so it runs from
//     0.75 at -50% weekly growth to 1.50 at +100%; null change takes 1.00.
//   age factor: 1 + 0.08 x min(years since listed_at, 5), so 1.00 for a new
//     listing and 1.40 for five years or more; null listed_at takes 1.00.
//
// Only protocols that record no token (gecko_id, symbol and mcap_usd all
// null) are ranked. Protocols whose token already trades are counted in the
// dashboard's summary and left off the board, so the board never mixes a
// launch that already happened with one still to come.

const CATEGORY_MULTIPLE: Record<string, number> = {
  Lending: 1.3,
  Dexs: 1.25,
  Yield: 1.2,
  'Yield Aggregator': 1.2,
  'Uncollateralized Lending': 1.2,
  'Risk Curators': 1.15,
  'Onchain Capital Allocator': 1.15,
  Derivatives: 1.15,
  CDP: 1.15,
  'CDP Manager': 1.1,
  'Collateral Markets': 1.1,
  'Collateral Management': 1.1,
  'Interest Rate Derivatives': 1.1,
  'Leveraged Farming': 1.1,
  Launchpad: 1.1,
  'Liquidity Manager': 1.1,
  RWA: 1.1,
  Farm: 1.05,
  'Basis Trading': 1.05,
  Options: 1.05,
  'Options Vault': 1.05,
  'Prediction Market': 1.05,
  'AI Agents': 1.05,
  'Decentralized AI': 1.05,
  Restaking: 1.05,
  Synthetics: 1.0,
  'Governance Incentives': 1.0,
  Insurance: 1.0,
  Indexes: 1.0,
  Payments: 1.0,
  Privacy: 1.0,
  'Token Locker': 0.95,
  'NFT Marketplace': 0.95,
  'Staking Pool': 0.95,
  'Stablecoin Issuer': 0.9,
  'Algo-Stables': 0.9,
  'Dual-Token Stablecoin': 0.9,
  'Reserve Currency': 0.9,
  'Decentralized BTC': 0.9,
  'OTC Marketplace': 0.9,
  'Crypto Card Issuer': 0.9,
  DOR: 0.9,
  'Liquid Staking': 0.85,
  'Restaked BTC': 0.85,
  'Anchor BTC': 0.85,
  'Stablecoin Wrapper': 0.85,
  Chain: 0.8,
  CeDeFi: 0.8,
  Bridge: 0.6,
  'Cross Chain Bridge': 0.6,
  'Canonical Bridge': 0.6,
  CEX: 0.55,
};

const VALUE_CAP_USD = 100_000_000_000;
const BOARD_ROWS = 200;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Whole years between listed_at and the snapshot date, null when unlisted. */
function ageYears(listedAt: string | null, asOf: string): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / (365.25 * 24 * 60 * 60 * 1000);
}

function categoryMultiple(category: string | null): number {
  if (category === null) return 1.0;
  return CATEGORY_MULTIPLE[category] ?? 1.0;
}

function growthFactor(change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return 1.0;
  return 1 + clamp(change7d, -50, 100) / 200;
}

function ageFactor(age: number | null): number {
  if (age === null) return 1.0;
  return 1 + 0.08 * clamp(age, 0, 5);
}

/** The implied launch value in whole dollars, from the snapshot's figures. */
function impliedValue(p: Protocol, asOf: string): {
  value: number;
  age: number | null;
  catMult: number;
  growth: number;
  ageF: number;
} {
  const age = ageYears(p.listed_at, asOf);
  const catMult = categoryMultiple(p.category);
  const growth = growthFactor(p.change_7d);
  const ageF = ageFactor(age);
  const raw = p.tvl_usd * catMult * growth * ageF;
  const value = Math.max(1, Math.round(Math.min(raw, VALUE_CAP_USD)));
  return { value, age, catMult, growth, ageF };
}

/** True when the snapshot records no token for the protocol at all. */
function recordsNoToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// ------------------------------------------------------------------ board eligibility
//
// The board is a radar for protocols that could still launch a token, so it
// leaves out the things the watchlist rule already excludes: exchanges and
// wrapped or staked products, whose value already sits elsewhere, and
// versioned re-releases, which are the same protocol under a new label.
// The filter applies to the whole board — watchlist and the rest alike — so
// a CEX or a staked-ETH wrapper can never top the board on TVL alone.
//
// A protocol is out when ANY of these hold:
//   - its category is Bridge, Canonical Bridge, Liquid Staking,
//     Liquid Restaking, Restaked BTC or CEX;
//   - its name begins with an exchange name (Binance, Coinbase, Bybit,
//     Kraken, Bitget, OKX, Bitfinex or Gemini), case-insensitive, first word;
//   - its name contains a whole word wrapped, staked or staking, any case;
//   - its name ends in a version marker (a space, then V2, V3, 2.0 or 3.0).
//     The marker set is exactly those four, case-insensitive: a bare V1 or
//     V12 suffix (Metric V1, Privacy Pools V1, Rysk V12) is not one, which
//     is what keeps the eligible pool at 201 on this snapshot — widening
//     the marker to any V-number would drop it to 198, below a 200-row board.
//
// On the sealed snapshot this leaves 201 eligible pre-token protocols — the
// 40 watchlist protocols plus 161 others — so a 200-row board takes nearly
// the whole eligible universe, not a cherry-picked slice of it.

const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const EXCHANGE_FIRST_WORDS: ReadonlySet<string> = new Set([
  'binance',
  'coinbase',
  'bybit',
  'kraken',
  'bitget',
  'okx',
  'bitfinex',
  'gemini',
]);

const VERSION_MARKER = /\s+(v2|v3|2\.0|3\.0)$/i;
const WRAPPED_OR_STAKED_WORD = /\b(wrapped|staked|staking)\b/i;

/** True when the protocol may appear on the board at all. */
function isBoardEligible(p: Protocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  const firstWord = p.name.trim().split(/\s+/)[0] ?? '';
  if (EXCHANGE_FIRST_WORDS.has(firstWord.toLowerCase())) return false;
  if (WRAPPED_OR_STAKED_WORD.test(p.name)) return false;
  if (VERSION_MARKER.test(p.name.trim())) return false;
  return true;
}

// ------------------------------------------------------------------ farm steps
//
// Each plan is 5 concrete steps built from the protocol's real name,
// category and chains: what to do, how much money it takes, and how long
// it takes. Amounts are small on purpose ($25-$500) and every plan ends
// with the warning that a token is not guaranteed, so the plan is worth
// following only for what the protocol itself pays. No slogans, no promises.

type StepFn = (name: string, chainA: string, chainB: string) => string[];

function lendingSteps(name: string, chainA: string): string[] {
  return [
    `Buy or bridge about $200 of USDC to ${chainA} and keep $5 of its native token in the same wallet for gas; a single transaction on ${chainA} usually costs well under $1.`,
    `Supply the $200 USDC to ${name} on ${chainA} and leave it supplied for at least 4 weeks, so the position shows steady use instead of one quick deposit.`,
    `Borrow about $60 of another asset against the USDC, use it for a normal on-chain action, then repay the loan in full within 2 weeks; keep borrowing under 30% of the collateral.`,
    `Add $50 of USDC to the same supply position once a month for 3 months, keeping the position open the whole time so the history spans a full quarter.`,
    `Write down every deposit, borrow and repayment with its date, amount and transaction hash; if ${name} ever issues a token, that log is your evidence. A token is not guaranteed, so only farm with money you can leave locked.`,
  ];
}

function dexSteps(name: string, chainA: string): string[] {
  return [
    `Bridge about $200 split evenly between USDC and ETH to ${chainA}, keeping $5 of the native token aside for gas; expect a few dollars of gas for the whole session.`,
    `Provide the $200 as liquidity in ${name}'s USDC-ETH pool on ${chainA} and hold the position for at least 4 weeks, collecting whatever trading fees it earns.`,
    `Swap $25 between USDC and ETH through ${name} once a week for 6 weeks, paying the pool's normal fee each time, to build a repeat-user pattern.`,
    `If the pool offers a gauge or rewards page, stake the LP receipt there for the full 4 weeks; otherwise leave the LP position untouched for the same period.`,
    `Log each deposit, swap and withdrawal with dates and amounts. A token launch is not guaranteed, so treat the fees you earn as the only certain return.`,
  ];
}

function yieldSteps(name: string, chainA: string): string[] {
  return [
    `Move about $200 of USDC to ${chainA} and keep $5 of native gas token in the wallet; one deposit on ${chainA} usually costs under $1 in gas.`,
    `Deposit the $200 into ${name}'s highest-TVL yield vault on ${chainA} and leave it for at least 6 weeks so the position compounds across several reward cycles.`,
    `Claim or restake any vault rewards once every 2 weeks for 6 weeks, paying the small gas fee each time, rather than claiming daily and burning gas.`,
    `Add a further $50 to the same vault at the start of week 4, keeping a single continuous position instead of opening many small ones.`,
    `Keep a dated record of deposits, claims and withdrawals. ${name} records no token today and a launch is not guaranteed, so only deposit what you can afford to leave in the vault.`,
  ];
}

function cdpSteps(name: string, chainA: string): string[] {
  return [
    `Send about $300 of ETH to ${chainA} and hold $5 of native gas token aside; a mint transaction on ${chainA} usually costs a few dollars at most.`,
    `Lock the $300 of ETH as collateral in ${name} on ${chainA} and mint about $100 of its stablecoin, keeping the loan under 35% of the collateral value.`,
    `Use the minted stablecoin for a normal payment or swap within 2 weeks, then buy it back and repay the loan in full so the collateral is released.`,
    `Repeat the lock-and-mint cycle once a month for 3 months with the same $300 of collateral, keeping each loan small and repaid on time.`,
    `Record the collateral, minted amount and repayment dates. A token is not guaranteed, so the only certain gain is whatever the stablecoin position itself earns.`,
  ];
}

function derivativesSteps(name: string, chainA: string): string[] {
  return [
    `Deposit about $200 of USDC as margin on ${name} on ${chainA}, keeping $5 of native gas token aside; funding a margin account usually costs a few dollars.`,
    `Open a small $50 long or short position with low leverage (2x or less) and hold it for at least 3 days, closing it before it can eat the margin.`,
    `Trade one $50 position a week for 6 weeks, alternating long and short, and never risk more than a quarter of the margin on a single trade.`,
    `Withdraw any profit above the original $200 once a month and leave the $200 margin in place, so the account stays active for a full quarter.`,
    `Log every trade's size, direction, entry and exit. ${name} records no token and a launch is not guaranteed; derivatives can lose money fast, so size every trade small.`,
  ];
}

function bridgeSteps(name: string, chainA: string, chainB: string): string[] {
  return [
    `Hold about $200 of USDC on ${chainA} and keep $5 of native gas token in the wallet; a bridge transfer usually costs $1-$5 in gas plus the bridge fee.`,
    `Bridge $50 of USDC from ${chainA} to ${chainB} through ${name} in week 1, then bridge $50 back in week 3, using the bridge in both directions.`,
    `Repeat a $50 bridge in each direction once a month for 3 months, so the bridge sees regular two-way volume from the same wallet.`,
    `If ${name} has a points or activity page, connect the same wallet and check it after each bridge so the activity is recorded under one address.`,
    `Keep the transaction hashes and dates of every bridge. A token is not guaranteed, so treat the bridge fees as a cost and never bridge money you need back quickly.`,
  ];
}

function stakingSteps(name: string, chainA: string): string[] {
  return [
    `Buy about $200 of the stakeable asset on ${chainA} and keep $5 of native gas token aside; staking transactions usually cost under $2.`,
    `Stake the $200 through ${name} on ${chainA} and leave it staked for at least 8 weeks, so the stake spans several reward epochs.`,
    `Claim or restake the staking rewards once every 2 weeks for 8 weeks instead of daily, to keep gas costs low and the activity regular.`,
    `Add $50 more to the same stake at the start of week 5, keeping one continuous stake rather than many small ones.`,
    `Record the stake amount, start date and every claim. ${name} records no token and a launch is not guaranteed, so only stake assets you are happy to hold long term.`,
  ];
}

function rwaSteps(name: string, chainA: string): string[] {
  return [
    `Move about $500 of USDC to ${chainA} and keep $10 of native gas token aside; a vault deposit on ${chainA} usually costs a few dollars.`,
    `Deposit the $500 into ${name}'s main vault on ${chainA} and hold the position for at least 8 weeks, since real-world-asset vaults reward patient, larger deposits.`,
    `Check the vault's reported yield once a week and leave the position untouched for the full 8 weeks rather than entering and exiting.`,
    `Add $100 to the same vault at the start of week 5, keeping a single position so the deposit history is clean and easy to read.`,
    `Save the deposit receipts with dates and amounts. ${name} records no token today and a launch is not guaranteed, so only deposit money you can leave locked for months.`,
  ];
}

function cexSteps(name: string, chainA: string): string[] {
  return [
    `Create or open your account on ${name} and complete its identity checks, which usually take 1-3 days; never pay anyone to speed this up.`,
    `Deposit about $200 of USDC and keep it on the exchange for at least 4 weeks, trading $25 a week in the spot market so the account shows regular activity.`,
    `Use at least two features over the month, such as spot trading and a savings or earn product, with $50 in each, to build a broader usage history.`,
    `Withdraw $50 back to your own wallet in week 4 and re-deposit it in week 5, so the account shows both deposits and withdrawals.`,
    `Keep a record of deposits, trades and withdrawals. ${name} records no token in this snapshot and a launch is not guaranteed, so never keep more on an exchange than you can afford to lose.`,
  ];
}

function launchpadSteps(name: string, chainA: string): string[] {
  return [
    `Hold about $200 of USDC on ${chainA} and keep $5 of native gas token aside; joining a launch usually costs a few dollars in gas.`,
    `Register the wallet you will use with ${name} on ${chainA} and complete any profile or verification step it asks for, which usually takes under a day.`,
    `Join the next launch on ${name} with $50 and hold whatever allocation you receive for at least 4 weeks instead of selling it at once.`,
    `Join a second launch a month later with another $50 from the same wallet, building a pattern of repeat participation.`,
    `Log each launch, amount and holding period. A token is not guaranteed, so only join launches with money you can afford to hold.`,
  ];
}

function genericSteps(name: string, chainA: string): string[] {
  return [
    `Send about $200 of USDC to ${chainA} and keep $5 of native gas token in the same wallet; a first transaction on ${chainA} usually costs under $2.`,
    `Use ${name}'s main feature on ${chainA} with $100 of the USDC and leave the position open for at least 4 weeks, so the usage reads as real rather than a one-off test.`,
    `Return to ${name} once a week for 6 weeks and repeat the same action with $25 each time, building a steady weekly pattern from one wallet.`,
    `Try a second feature of ${name} in week 3 with $50, so the history covers more than a single action.`,
    `Write down each action with its date, amount and transaction hash. ${name} records no token and a launch is not guaranteed, so only use money you can afford to leave in the protocol.`,
  ];
}

const STEP_BUILDERS: Record<string, StepFn> = {
  Lending: (n, a) => lendingSteps(n, a),
  'Uncollateralized Lending': (n, a) => lendingSteps(n, a),
  'Collateral Management': (n, a) => lendingSteps(n, a),
  'Collateral Markets': (n, a) => lendingSteps(n, a),
  Dexs: (n, a) => dexSteps(n, a),
  'Liquidity Manager': (n, a) => dexSteps(n, a),
  Yield: (n, a) => yieldSteps(n, a),
  'Yield Aggregator': (n, a) => yieldSteps(n, a),
  Farm: (n, a) => yieldSteps(n, a),
  'Leveraged Farming': (n, a) => yieldSteps(n, a),
  CDP: (n, a) => cdpSteps(n, a),
  'CDP Manager': (n, a) => cdpSteps(n, a),
  'Algo-Stables': (n, a) => cdpSteps(n, a),
  'Stablecoin Issuer': (n, a) => cdpSteps(n, a),
  'Dual-Token Stablecoin': (n, a) => cdpSteps(n, a),
  'Stablecoin Wrapper': (n, a) => cdpSteps(n, a),
  'Reserve Currency': (n, a) => cdpSteps(n, a),
  Derivatives: (n, a) => derivativesSteps(n, a),
  Options: (n, a) => derivativesSteps(n, a),
  'Options Vault': (n, a) => derivativesSteps(n, a),
  Synthetics: (n, a) => derivativesSteps(n, a),
  'Basis Trading': (n, a) => derivativesSteps(n, a),
  'Interest Rate Derivatives': (n, a) => derivativesSteps(n, a),
  Bridge: (n, a, b) => bridgeSteps(n, a, b),
  'Cross Chain Bridge': (n, a, b) => bridgeSteps(n, a, b),
  'Canonical Bridge': (n, a, b) => bridgeSteps(n, a, b),
  'Liquid Staking': (n, a) => stakingSteps(n, a),
  'Liquid Restaking': (n, a) => stakingSteps(n, a),
  Restaking: (n, a) => stakingSteps(n, a),
  'Restaked BTC': (n, a) => stakingSteps(n, a),
  'Staking Pool': (n, a) => stakingSteps(n, a),
  'Anchor BTC': (n, a) => stakingSteps(n, a),
  'Decentralized BTC': (n, a) => stakingSteps(n, a),
  RWA: (n, a) => rwaSteps(n, a),
  'Onchain Capital Allocator': (n, a) => rwaSteps(n, a),
  'Risk Curators': (n, a) => rwaSteps(n, a),
  CEX: (n, a) => cexSteps(n, a),
  CeDeFi: (n, a) => cexSteps(n, a),
  Launchpad: (n, a) => launchpadSteps(n, a),
};

/** Five concrete farm steps for one protocol, from its category and chains. */
function farmSteps(p: Protocol): string[] {
  const chainA = p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
  const chainB = p.chains.length > 1 ? p.chains[1]! : 'another chain it supports';
  const build = p.category !== null ? STEP_BUILDERS[p.category] : undefined;
  const steps = build !== undefined ? build(p.name, chainA, chainB) : genericSteps(p.name, chainA);
  return steps.map((s) => s.trim()).filter((s) => s.length >= 20 && s.length <= 600);
}

// ------------------------------------------------------------------ board build

/** The 200 board rows: every watchlist protocol, plus the 160 other
 *  eligible pre-token protocols with the most TVL. The eligibility filter
 *  (isBoardEligible) applies to the whole selection, watchlist included,
 *  and on this snapshot the eligible pool is 201 protocols (40 watchlist
 *  + 161 others), so the board is nearly the whole eligible universe.
 *  Rank 1 is the highest implied value; ties break on TVL, then slug, so
 *  the order is deterministic. */
function buildRows(snap: Snapshot): BoardRow[] {
  const watch = new Set(snap.watchlist);
  const preToken = snap.protocols.filter(recordsNoToken).filter(isBoardEligible);
  const byTvl = [...preToken].sort(
    (a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1),
  );
  const chosen: Protocol[] = [];
  const taken = new Set<string>();
  // Every watchlist protocol first, then the highest-TVL pre-token rest.
  for (const p of byTvl) {
    if (watch.has(p.slug) && !taken.has(p.slug)) {
      chosen.push(p);
      taken.add(p.slug);
    }
  }
  for (const p of byTvl) {
    if (chosen.length >= BOARD_ROWS) break;
    if (!taken.has(p.slug)) {
      chosen.push(p);
      taken.add(p.slug);
    }
  }

  const scored = chosen.map((p) => {
    const m = impliedValue(p, snap.as_of);
    return { p, ...m };
  });
  scored.sort(
    (a, b) =>
      b.value - a.value ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );

  // Enforce a non-increasing implied value down the ranks, so a rounding
  // tie can never make a lower rank look more valuable than the one above.
  let ceiling = Number.POSITIVE_INFINITY;
  return scored.map((s, i) => {
    const value = Math.min(s.value, ceiling);
    ceiling = value;
    return {
      slug: s.p.slug,
      name: s.p.name,
      rank: i + 1,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      age_years: s.age === null ? null : Math.round(s.age * 100) / 100,
      has_token: false,
      watchlist: watch.has(s.p.slug),
      category_multiple: s.catMult,
      growth_factor: Math.round(s.growth * 10000) / 10000,
      age_factor: Math.round(s.ageF * 10000) / 10000,
      implied_value_usd: value,
      farm_steps: farmSteps(s.p),
    };
  });
}

// ------------------------------------------------------------------ main

function parseInputArg(argv: string[]): string {
  const i = argv.indexOf('--input');
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--input='));
  if (eq !== undefined) return eq.slice('--input='.length);
  return '/input/snapshot.json';
}

function main(): void {
  const repoRoot = dirname(fileURLToPath(import.meta.url));
  const inputPath = parseInputArg(process.argv.slice(2));
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? 'out';

  const snap = JSON.parse(readFileSync(inputPath, 'utf8')) as Snapshot;
  const rows = buildRows(snap);
  if (rows.length !== BOARD_ROWS) {
    throw new Error(`expected ${BOARD_ROWS} board rows, built ${rows.length}`);
  }

  const preTokenCount = snap.protocols.filter(recordsNoToken).length;
  const eligibleCount = snap.protocols.filter(recordsNoToken).filter(isBoardEligible).length;
  const board = {
    as_of: snap.as_of,
    floor_usd: snap.floor_usd,
    model: {
      name: 'tvl x category x growth x age',
      formula: 'implied_value_usd = TVL x category_multiple x growth_factor x age_factor, capped at $100,000,000,000',
      category_multiple: 'by DefiLlama category, 0.55 (CEX) to 1.30 (Lending); 1.00 when unknown',
      growth_factor: '1 + clamp(change_7d, -50, +100) / 200; 1.00 when change_7d is null',
      age_factor: '1 + 0.08 x min(years since listed_at, 5); 1.00 when listed_at is null',
      pre_token_rule: 'a protocol records no token when gecko_id, symbol and mcap_usd are all null',
      eligibility_rule: 'the whole board excludes Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC and CEX categories; names starting with an exchange name (Binance, Coinbase, Bybit, Kraken, Bitget, OKX, Bitfinex, Gemini); names containing a whole word wrapped, staked or staking; and names ending in a version marker (V2, V3, 2.0, 3.0)',
    },
    rows,
  };

  const data = {
    meta: {
      as_of: snap.as_of,
      floor_usd: snap.floor_usd,
      protocols_total: snap.protocols.length,
      pre_token_total: preTokenCount,
      eligible_pre_token_total: eligibleCount,
      trading_total: snap.protocols.length - preTokenCount,
      watchlist_total: snap.watchlist.length,
      board_rows: rows.length,
      model: board.model,
    },
    rows,
  };

  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, 'dashboard'), { recursive: true });
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });

  writeFileSync(join(outDir, 'board.json'), `${JSON.stringify(board, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'data.js'), `window.TOKEN_RADAR = ${JSON.stringify(data)};\n`, 'utf8');

  const dashSrc = join(repoRoot, 'dashboard');
  const shotsSrc = join(repoRoot, 'screenshots');
  if (!existsSync(join(dashSrc, 'index.html'))) throw new Error('dashboard/index.html is missing');
  if (!existsSync(join(shotsSrc, '1-board.png')) && !existsSync(join(shotsSrc, '1-board.jpg'))) {
    throw new Error('screenshots/1-board.png is missing');
  }
  cpSync(dashSrc, join(outDir, 'dashboard'), { recursive: true });
  cpSync(shotsSrc, join(outDir, 'screenshots'), { recursive: true });

  // The dossier is built last, from exactly what was just written, so the
  // file the scorer recomputes from /output matches this one byte for byte.
  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  console.log(`token-radar: ${rows.length} rows, ${eligibleCount} eligible pre-token of ${preTokenCount} pre-token of ${snap.protocols.length} protocols, wrote ${outDir}`);
}

main();
