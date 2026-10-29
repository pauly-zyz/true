// Renders reports/phase0.md from data/phase0/analysis.json (+ optional hand-written
// reports/phase0-notes.md with the conclusions, kept separate so judgement is explicit).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DATA, ROOT } from "./common.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- analysis.json is our own output */
const a = JSON.parse(readFileSync(`${DATA}/analysis.json`, "utf8")) as any;
const notesFile = `${ROOT}reports/phase0-notes.md`;
const notes = existsSync(notesFile) ? readFileSync(notesFile, "utf8").trim() : "_(belum ada catatan kesimpulan)_";

const usd = (x: number | null | undefined, d = 2) =>
  x === null || x === undefined ? "–" : `$${x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "–" : `${(x * 100).toFixed(d)}%`);
const num = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "–" : x.toFixed(d));
const table = (head: string[], rows: Array<Array<string | number>>) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

const w = a.window;
const tierRows = (tiers: any[]) =>
  tiers.map((t) => [
    usd(t.tier, 0),
    t.episodes,
    num(t.episodesPerDay, 1),
    pct(t.snapshotsWithHitFraction, 0),
    usd(t.medianNotionalUsd),
    usd(t.medianNetUsd),
    num(t.medianNetBps, 0),
    t.persistMin.p50 === null ? "–" : `${num(t.persistMin.p50, 0)} / ${num(t.persistMin.max, 0)}`,
    `${usd(t.dailyNetUsd.lower)} – ${usd(t.dailyNetUsd.upper)}`,
    `${num(t.dailyRoiPct.lower, 2)}% – ${num(t.dailyRoiPct.upper, 2)}%`,
  ]);
const tierHead = [
  "Modal",
  "Episode",
  "Episode/hari",
  "% snapshot ada peluang",
  "Median ukuran",
  "Median net",
  "Median net (bps)",
  "Bertahan p50 / max (menit)",
  "Net/hari (bawah – atas)",
  "ROI/hari",
];

const md = `# Fase 0 — Validasi ekonomi arbitrase koin Pangea

_Dibuat otomatis oleh \`pnpm phase0\` pada ${a.generatedAt}. Angka berasal dari data on-chain yang dibaca lewat API Pangea dan RPC Robinhood Chain; tidak ada transaksi yang dikirim._

## Ringkasan

${notes}

## Data dan metode

| Sumber | Isi | Periode |
| --- | --- | --- |
| \`GET /api/pools\` tiap ${num(w.intervalMin, 1)} menit | sqrtPrice, liquidity, tick dan reserves per chain untuk semua launch | ${w.from} → ${w.to} (${w.snapshots} snapshot, ≈${num(w.observedHours, 1)} jam) |
| RPC Robinhood Chain | event \`Initialize\`/\`ModifyLiquidity\` dan klaim fee hook (ERC-6909) per pool | 25 koin teratas |
| \`GET /api/history?hours=168\` | candle per chain, jumlah trade dan volume 7 hari | ${a.history.length} koin teratas |
| \`quoteSend\` (read-only) di Robinhood | fee pesan LayerZero per tujuan | 1 kali |

**Model pool.** Setiap pool dibangun ulang dari snapshot: Uniswap v4 sebagai satu posisi \`[tick minimum, tickUpper]\` dengan liquidity \`L\` (tickUpper diturunkan dari reserves, cocok persis dengan nilai on-chain di Robinhood), Meteora DAMM v2 sebagai satu posisi \`[sqrtMin, sqrtMax]\`. Harga dan reserves hasil model cocok dengan angka Pangea di kelima chain (selisih < 0,1%).

**Fee.** Pool EVM Pangea punya LP fee 0; trading fee dipungut **hook** di sisi ETH/BNB (dari input saat beli, dari output saat jual). Tarif per koin diukur dari klaim hook di transaksi nyata di Robinhood (3 sampel konsisten per koin) dan dianggap sama di semua chain karena Pangea menetapkan fee sekali per launch. Golden test mereproduksi dua transaksi nyata sampai ke wei.

**Peluang.** Untuk setiap snapshot, koin dan pasangan chain (beli di chain murah, jual di chain mahal secara bersamaan, mode inventaris), ukuran trade dioptimalkan dengan matematika pool yang eksak, lalu dikurangi: fee hook dua sisi, slippage, gas dua chain, fee bridge 0,2% (dengan pembulatan 6 desimal), fee LayerZero rute rebalance, biaya memindahkan quote asset (${a.assumptions.quoteRebalanceBps} bps) dan margin risiko (${a.assumptions.riskMarginBps} bps). Sebuah trade dihitung hanya bila lolos semua parameter risiko RANCANGAN 2.3: net ≥ ${usd(a.assumptions.risk.minNetProfitUsd)} dan ≥ ${a.assumptions.risk.minNetProfitBps} bps, ukuran ≤ ${pct(a.assumptions.risk.maxTradeFractionOfSmallerPool, 0)} likuiditas pool terkecil, ≤ ${pct(a.assumptions.risk.maxExposurePerCoinFraction, 0)} modal per koin, market cap ≥ ${usd(a.assumptions.risk.minMarketCapUsd, 0)}.

**Episode.** Peluang yang sama (koin + pasangan chain) di snapshot berturut-turut dihitung sebagai satu episode. Batas **bawah** profit harian = satu kali tangkap per episode (net di snapshot pertama), diekstrapolasi ke 24 jam. Batas **atas** = setiap snapshot yang punya peluang dihitung (seolah gap terisi lagi tiap ${num(w.intervalMin, 0)} menit). Gap yang muncul dan hilang di antara dua snapshot tidak terlihat, sehingga frekuensi sebenarnya bisa lebih tinggi, tapi gap seperti itu juga yang paling cepat direbut bot lain.

## Hasil per ukuran modal (konfigurasi dasar)

${table(tierHead, tierRows(a.tiers))}

Dengan asumsi TRUE hanya memenangkan sebagian peluang (pesaing seperti bot $PANGEA dan ZGAP):

${table(
  ["Modal", ...a.tiers[0].byCapture.map((c: any) => `Menang ${pct(c.rate, 0)}`)],
  a.tiers.map((t: any) => [usd(t.tier, 0), ...t.byCapture.map((c: any) => `${usd(c.lower)} – ${usd(c.upper)}`)]),
)}

### Rata-rata komponen biaya per trade yang lolos

${table(
  ["Modal", "Fee trading", "Slippage", "Gas", "Fee bridge", "LayerZero", "Rebalance quote", "Margin risiko"],
  a.tiers.map((t: any) => [
    usd(t.tier, 0),
    usd(t.avgCosts.tradingFeeUsd),
    usd(t.avgCosts.slippageUsd),
    usd(t.avgCosts.gasUsd),
    usd(t.avgCosts.bridgeFeeUsd),
    usd(t.avgCosts.lzFeeUsd),
    usd(t.avgCosts.quoteRebalanceUsd),
    usd(t.avgCosts.riskMarginUsd),
  ]),
)}

### Pasangan chain yang paling sering memberi peluang (modal terbesar)

${(() => {
  const pc = Object.entries(a.tiers.at(-1).pairCounts as Record<string, number>).sort((x, y) => y[1] - x[1]);
  return pc.length ? table(["Beli → Jual", "Episode"], pc.slice(0, 10).map(([k, v]) => [k, v])) : "_Tidak ada._";
})()}

## Skenario sensitivitas

${a.scenarios
  .map((s: any) => `### ${s.name}\n\n${s.description}.\n\n${table(tierHead, tierRows(s.tiers))}`)
  .join("\n\n")}

## Per koin (snapshot terakhir dan sepanjang jendela)

Breakeven = gap minimum agar trade kecil impas (2 × fee + fee bridge + margin + rebalance), sebelum gas, LayerZero dan slippage.

${table(
  ["Koin", "Fee", "Likuiditas quote (5 chain)", "Market cap", "Spread sekarang", "True Score", "Spread p50 / p90", "Breakeven", "% snapshot bisa dieksekusi*", "Alasan penolakan utama"],
  a.coins.map((c: any) => [
    c.symbol ?? c.slug,
    pct(c.feePct / 100, 1),
    usd(c.quoteLiqUsd, 0),
    usd(c.marketCapUsd, 0),
    pct(c.spreadNow),
    num(c.trueScoreNow, 0),
    `${pct(c.spreadP50)} / ${pct(c.spreadP90)}`,
    pct(c.breakevenGap),
    pct(c.executableFractionTopTier, 0),
    c.mainReject ?? "–",
  ]),
)}

\\* pada modal ${usd(a.tiers.at(-1).tier, 0)}.

## Riwayat 7 hari (candle \`/api/history\`)

Resolusi candle kasar (≈${num(a.history[0]?.bucketHours, 2)} jam per bucket), jadi ini hanya menunjukkan seberapa sering harga penutupan antar-chain berbeda melebihi breakeven, bukan berapa lama gap bertahan.

${table(
  ["Koin", "Volume 7 hari", "Trade 7 hari", "Trade per chain (eth/base/rh/bsc/sol)", "Spread p50 / p90", "% bucket > breakeven"],
  [...a.history]
    .sort((x: any, y: any) => y.volumeUsd7d - x.volumeUsd7d)
    .map((h: any) => [
      h.symbol,
      usd(h.volumeUsd7d, 0),
      h.trades7d,
      ["ethereum", "base", "robinhood", "bsc", "solana"].map((c) => h.tradesByChain?.[c] ?? 0).join(" / "),
      `${pct(h.spreadP50)} / ${pct(h.spreadP90)}`,
      pct(h.aboveBreakevenFraction, 0),
    ]),
)}

## Peluang terbesar yang teramati

${table(
  ["Modal", "Koin", "Beli → Jual", "Snapshot berturut-turut", "Ukuran", "Net pertama", "Net maks"],
  a.topEpisodes.map((e: any) => [usd(e.tier, 0), e.slug, `${e.buy} → ${e.sell}`, e.snapshots, usd(e.firstNotionalUsd), usd(e.firstNetUsd), usd(e.maxNetUsd)]),
)}

## Asumsi dan keterbatasan

- **Harga gas** belum dibaca on-chain (RPC Ethereum, Base, BSC dan Solana belum tersedia di lingkungan ini). Dipakai nilai config: ${Object.entries(a.assumptions.gasPrices)
  .map(([k, v]) => `${k} ${v}`)
  .join(", ")} (gwei untuk EVM, micro-lamports/CU untuk Solana).
- **Fee LayerZero** dari \`quoteSend\` di Robinhood (ke Base/BSC/Ethereum/Solana) dan contoh di dokumentasi Pangea; rute dari chain lain diasumsikan serupa.
- **Fee hook** diukur di Robinhood saja; diasumsikan sama di Ethereum, Base dan BSC. Pool Solana diasumsikan memakai fee yang sama tanpa fee dinamis/scheduler (belum diverifikasi on-chain).
- **Snapshot \`/api/pools\`** adalah satu pembacaan bersama yang di-cache Pangea maksimal 60 detik; kelima chain mungkin tidak terbaca di detik yang sama.
- **Harga USD** ETH/BNB/SOL memakai kurs di snapshot Pangea (coinbase + dexscreener + kraken), bukan Chainlink, agar konsisten dengan waktu pembacaan pool.
- Resolusi 5 menit tidak bisa mengukur durasi gap dalam detik; untuk itu dibutuhkan log swap on-chain di kelima chain (RPC).
`;

writeFileSync(`${ROOT}reports/phase0.md`, md);
console.log(`wrote reports/phase0.md (${md.length} chars)`);
