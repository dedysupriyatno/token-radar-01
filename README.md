# Token Launch Radar

![token-radar-01](https://make.fun/badge/token-radar-01.svg)
![rank](https://make.fun/badge/token-radar-01/dedysupriyatno/token-radar-01/rank.svg)
![reward](https://make.fun/badge/token-radar-01/dedysupriyatno/token-radar-01/reward.svg)

[Token Launch Radar on make.fun](https://make.fun/bounty/token-radar-01)

A token launch radar: it reads a sealed DefiLlama snapshot, finds the protocols that record no token yet, ranks them by what their launch would be worth, and shows a reader how to farm each one. Built for the [make.fun token-radar-01 bounty](https://make.fun/bounty/token-radar-01).

## What it does

`main.ts` reads the snapshot at `/input/snapshot.json` (or `--input <path>`), builds a 200-row board — every one of the 40 watchlist protocols plus the 160 other pre-token protocols with the most TVL — and writes:

- `board.json` — the ranked board, one row per protocol with its implied value and farm plan
- `data.js` — the same board as data for the dashboard
- `dashboard/` and `screenshots/` — copied through unchanged
- `dossier.json` — built with `buildDossier` from `vendor/makefun-board.ts`

The dashboard (`dashboard/index.html`) is a static page with no network: a sortable board table, filters by category, chain and text, a watchlist-only switch, a pre-token-only switch, and a detail view for every protocol showing all its snapshot fields, the implied-value breakdown and its farm steps. Deep links work: `?slug=<slug>` opens a protocol's detail, `?filter=<category>` applies a category filter.

## The value model

```
implied value = TVL × category multiple × growth factor × age factor
```

capped at $100,000,000,000 and rounded to whole dollars. The category multiple runs 0.55 for a CEX to 1.30 for Lending (1.00 when the category is unknown); the growth factor is `1 + clamp(7-day TVL change, −50%, +100%) / 200`; the age factor is `1 + 0.08 × min(years since listed, 5)`. A protocol counts as pre-token only when the snapshot records no token for it at all — CoinGecko id, symbol and market cap all null. Protocols whose token already trades are counted in the dashboard summary and left off the board. The implied value is this entry's own claim from the snapshot's figures, never a prediction that a token will launch; farm steps always warn that a token is not guaranteed.

## How to run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path to snapshot.json>
```

Node 22.18 or later, standard library only, no install step. The program is deterministic: two runs write identical bytes. Open `out/dashboard/index.html` in a browser to use the board (it reads `out/data.js`).

`screenshots/` holds three captures of the built dashboard at 1440×900: the full board, the detail view for `steakhouse-financial` (the top watchlist protocol by TVL), and the board filtered to Lending.

## License

MIT — see `LICENSE`.
