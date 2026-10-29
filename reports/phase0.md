# Fase 0 — Validasi ekonomi arbitrase koin Pangea

_Dibuat otomatis oleh `pnpm phase0` pada 2026-10-29T17:40:38.133Z. Angka berasal dari data on-chain yang dibaca lewat API Pangea dan RPC Robinhood Chain; tidak ada transaksi yang dikirim._

## Ringkasan

_(belum ada catatan kesimpulan)_

## Data dan metode

| Sumber | Isi | Periode |
| --- | --- | --- |
| `GET /api/pools` tiap 5.1 menit | sqrtPrice, liquidity, tick dan reserves per chain untuk semua launch | 2026-10-29T17:29:17.399Z → 2026-10-29T17:39:30.605Z (3 snapshot, ≈0.3 jam) |
| RPC Robinhood Chain | event `Initialize`/`ModifyLiquidity` dan klaim fee hook (ERC-6909) per pool | 25 koin teratas |
| `GET /api/history?hours=168` | candle per chain, jumlah trade dan volume 7 hari | 20 koin teratas |
| `quoteSend` (read-only) di Robinhood | fee pesan LayerZero per tujuan | 1 kali |

**Model pool.** Setiap pool dibangun ulang dari snapshot: Uniswap v4 sebagai satu posisi `[tick minimum, tickUpper]` dengan liquidity `L` (tickUpper diturunkan dari reserves, cocok persis dengan nilai on-chain di Robinhood), Meteora DAMM v2 sebagai satu posisi `[sqrtMin, sqrtMax]`. Harga dan reserves hasil model cocok dengan angka Pangea di kelima chain (selisih < 0,1%).

**Fee.** Pool EVM Pangea punya LP fee 0; trading fee dipungut **hook** di sisi ETH/BNB (dari input saat beli, dari output saat jual). Tarif per koin diukur dari klaim hook di transaksi nyata di Robinhood (3 sampel konsisten per koin) dan dianggap sama di semua chain karena Pangea menetapkan fee sekali per launch. Golden test mereproduksi dua transaksi nyata sampai ke wei.

**Peluang.** Untuk setiap snapshot, koin dan pasangan chain (beli di chain murah, jual di chain mahal secara bersamaan, mode inventaris), ukuran trade dioptimalkan dengan matematika pool yang eksak, lalu dikurangi: fee hook dua sisi, slippage, gas dua chain, fee bridge 0,2% (dengan pembulatan 6 desimal), fee LayerZero rute rebalance, biaya memindahkan quote asset (10 bps) dan margin risiko (30 bps). Sebuah trade dihitung hanya bila lolos semua parameter risiko RANCANGAN 2.3: net ≥ $1.00 dan ≥ 30 bps, ukuran ≤ 2% likuiditas pool terkecil, ≤ 5% modal per koin, market cap ≥ $20,000.

**Episode.** Peluang yang sama (koin + pasangan chain) di snapshot berturut-turut dihitung sebagai satu episode. Batas **bawah** profit harian = satu kali tangkap per episode (net di snapshot pertama), diekstrapolasi ke 24 jam. Batas **atas** = setiap snapshot yang punya peluang dihitung (seolah gap terisi lagi tiap 5 menit). Gap yang muncul dan hilang di antara dua snapshot tidak terlihat, sehingga frekuensi sebenarnya bisa lebih tinggi, tapi gap seperti itu juga yang paling cepat direbut bot lain.

## Hasil per ukuran modal (konfigurasi dasar)

| Modal | Episode | Episode/hari | % snapshot ada peluang | Median ukuran | Median net | Median net (bps) | Bertahan p50 / max (menit) | Net/hari (bawah – atas) | ROI/hari |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| $500 | 1 | 93.9 | 67% | $25.00 | $1.24 | 497 | 10 / 10 | $116.79 – $237.93 | 23.36% – 47.59% |
| $2,000 | 3 | 281.8 | 100% | $57.77 | $1.27 | 267 | 15 / 15 | $388.26 – $1,102.37 | 19.41% – 55.12% |
| $10,000 | 3 | 281.8 | 100% | $57.77 | $1.27 | 267 | 15 / 15 | $388.26 – $1,102.37 | 3.88% – 11.02% |
| $50,000 | 3 | 281.8 | 100% | $57.77 | $1.27 | 267 | 15 / 15 | $388.26 – $1,102.37 | 0.78% – 2.20% |

Dengan asumsi TRUE hanya memenangkan sebagian peluang (pesaing seperti bot $PANGEA dan ZGAP):

| Modal | Menang 100% | Menang 50% | Menang 25% |
| --- | --- | --- | --- |
| $500 | $116.79 – $237.93 | $58.39 – $118.96 | $29.20 – $59.48 |
| $2,000 | $388.26 – $1,102.37 | $194.13 – $551.19 | $97.07 – $275.59 |
| $10,000 | $388.26 – $1,102.37 | $194.13 – $551.19 | $97.07 – $275.59 |
| $50,000 | $388.26 – $1,102.37 | $194.13 – $551.19 | $97.07 – $275.59 |

### Rata-rata komponen biaya per trade yang lolos

| Modal | Fee trading | Slippage | Gas | Fee bridge | LayerZero | Rebalance quote | Margin risiko |
| --- | --- | --- | --- | --- | --- | --- | --- |
| $500 | $1.04 | $0.39 | $0.09 | $0.05 | $0.06 | $0.03 | $0.07 |
| $2,000 | $1.97 | $1.59 | $0.06 | $0.12 | $0.06 | $0.06 | $0.17 |
| $10,000 | $1.97 | $1.59 | $0.06 | $0.12 | $0.06 | $0.06 | $0.17 |
| $50,000 | $1.97 | $1.59 | $0.06 | $0.12 | $0.06 | $0.06 | $0.17 |

### Pasangan chain yang paling sering memberi peluang (modal terbesar)

| Beli → Jual | Episode |
| --- | --- |
| solana→ethereum | 2 |
| solana→base | 1 |

## Skenario sensitivitas

### batched-rebalance

LayerZero fee shared by 10 trades (inventory rebalanced in batches).

| Modal | Episode | Episode/hari | % snapshot ada peluang | Median ukuran | Median net | Median net (bps) | Bertahan p50 / max (menit) | Net/hari (bawah – atas) | ROI/hari |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| $500 | 2 | 187.9 | 67% | $25.00 | $1.30 | 519 | 5 / 10 | $218.44 – $344.66 | 43.69% – 68.93% |
| $2,000 | 4 | 375.7 | 100% | $59.16 | $1.44 | 269 | 15 / 15 | $539.31 – $1,550.06 | 26.97% – 77.50% |
| $10,000 | 4 | 375.7 | 100% | $59.16 | $1.44 | 269 | 15 / 15 | $539.31 – $1,550.06 | 5.39% – 15.50% |
| $50,000 | 4 | 375.7 | 100% | $59.16 | $1.44 | 269 | 15 / 15 | $539.31 – $1,550.06 | 1.08% – 3.10% |

### batched-low-min

batched rebalance and minimum net profit lowered to $0.25.

| Modal | Episode | Episode/hari | % snapshot ada peluang | Median ukuran | Median net | Median net (bps) | Bertahan p50 / max (menit) | Net/hari (bawah – atas) | ROI/hari |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| $500 | 6 | 563.6 | 100% | $25.00 | $0.76 | 304 | 10 / 15 | $392.90 – $817.12 | 78.58% – 163.42% |
| $2,000 | 4 | 375.7 | 100% | $59.16 | $1.33 | 212 | 15 / 15 | $528.15 – $1,643.04 | 26.41% – 82.15% |
| $10,000 | 4 | 375.7 | 100% | $59.16 | $1.33 | 212 | 15 / 15 | $528.15 – $1,643.04 | 5.28% – 16.43% |
| $50,000 | 4 | 375.7 | 100% | $59.16 | $1.33 | 212 | 15 / 15 | $528.15 – $1,643.04 | 1.06% – 3.29% |

## Per koin (snapshot terakhir dan sepanjang jendela)

Breakeven = gap minimum agar trade kecil impas (2 × fee + fee bridge + margin + rebalance), sebelum gas, LayerZero dan slippage.

| Koin | Fee | Likuiditas quote (5 chain) | Market cap | Spread sekarang | True Score | Spread p50 / p90 | Breakeven | % snapshot bisa dieksekusi* | Alasan penolakan utama |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PANGEA | 1.0% | $304,356 | $7,071,231 | 2.1% | 58 | 2.1% / 2.3% | 2.6% | 0% | net profit # < # |
| ONECOIN | 1.0% | $43,383 | $227,163 | 3.7% | 27 | 4.0% / 4.1% | 2.6% | 0% | net profit # < # |
| ZGAP | 1.0% | $30,550 | $137,750 | 2.0% | 60 | 2.4% / 3.9% | 2.6% | 0% | net profit # < # |
| PVE | 2.0% | $25,612 | $111,116 | 8.5% | 0 | 8.5% / 8.5% | 4.6% | 67% | net profit # < # |
| WAGMI | 2.0% | $18,674 | $156,461 | 5.1% | 0 | 5.0% / 5.1% | 4.6% | 0% | net profit # < # |
| WOJAK | 1.0% | $13,555 | $53,925 | 7.9% | 0 | 7.9% / 7.9% | 2.6% | 0% | net profit # < # |
| PCAT | 2.0% | $6,319 | $29,693 | 6.2% | 0 | 5.7% / 6.2% | 4.6% | 0% | net profit # < # |
| CYBER | 1.0% | $5,485 | $27,426 | 1.9% | 62 | 2.0% / 2.0% | 2.6% | 0% | – |
| MAKERS | 5.0% | $3,827 | $23,866 | 9.5% | 0 | 9.4% / 9.5% | 10.6% | 0% | – |
| PEPE | 2.0% | $3,738 | $22,678 | 5.7% | 0 | 5.6% / 5.7% | 4.6% | 0% | net profit # < # |
| FLAT | 2.0% | $2,845 | $20,566 | 12.5% | 0 | 12.5% / 12.5% | 4.6% | 100% | – |
| YEE | 1.0% | $2,786 | $20,829 | 8.5% | 0 | 8.5% / 8.5% | 2.6% | 100% | – |
| VBTCV | 1.0% | $2,185 | $19,297 | 10.5% | 0 | 10.5% / 10.5% | 2.6% | 0% | market cap below minimum |
| OMNI | 1.0% | $2,181 | $19,049 | 6.9% | 0 | 6.9% / 6.9% | 2.6% | 0% | market cap below minimum |
| ONE | 2.0% | $1,688 | $17,794 | 8.8% | 0 | 8.9% / 8.9% | 4.6% | 0% | market cap below minimum |
| FORGE | 1.0% | $1,537 | $18,359 | 5.5% | 0 | 5.5% / 5.6% | 2.6% | 0% | market cap below minimum |
| KERMIT | 0.3% | $1,256 | $16,925 | 5.2% | 0 | 5.2% / 5.3% | 1.2% | 0% | market cap below minimum |
| DINU | 3.0% | $1,243 | $5,914 | 27.7% | 0 | 27.8% / 27.9% | 6.6% | 0% | market cap below minimum |
| PI10 | 2.0% | $1,143 | $19,937 | 9.6% | 0 | 9.5% / 9.6% | 4.6% | 0% | market cap below minimum |
| DACITY | 2.0% | $1,035 | $16,354 | 11.8% | 0 | 11.8% / 11.8% | 4.6% | 0% | market cap below minimum |
| 1NU | 0.3% | $1,029 | $16,890 | 5.9% | 0 | 6.0% / 6.1% | 1.2% | 0% | market cap below minimum |
| ASTEROID | 1.0% | $986 | $16,464 | 2.3% | 53 | 2.3% / 2.3% | 2.6% | 0% | market cap below minimum |
| DRIFT | 1.0% | $972 | $17,316 | 11.3% | 0 | 11.3% / 11.3% | 2.6% | 0% | market cap below minimum |
| CHAT | 0.3% | $940 | $16,240 | 4.8% | 5 | 4.8% / 4.8% | 1.2% | 0% | market cap below minimum |
| WPC | 1.0% | $904 | $5,089 | 3.7% | 27 | 3.7% / 3.9% | 2.6% | 0% | market cap below minimum |

\* pada modal $50,000.

## Riwayat 7 hari (candle `/api/history`)

Resolusi candle kasar (≈1.75 jam per bucket), jadi ini hanya menunjukkan seberapa sering harga penutupan antar-chain berbeda melebihi breakeven, bukan berapa lama gap bertahan.

| Koin | Volume 7 hari | Trade 7 hari | Trade per chain (eth/base/rh/bsc/sol) | Spread p50 / p90 | % bucket > breakeven |
| --- | --- | --- | --- | --- | --- |
| PANGEA | $16,396,483 | 85761 | 3325 / 8894 / 30206 / 12418 / 30918 | 2.9% / 5.1% | 56% |
| ONECOIN | $8,150,312 | 87971 | 2021 / 7314 / 12470 / 44836 / 21330 | 3.8% / 6.6% | 78% |
| ZGAP | $4,020,652 | 41762 | 1698 / 5250 / 10423 / 5642 / 18749 | 3.6% / 7.3% | 81% |
| PVE | $3,430,946 | 29261 | 1255 / 3099 / 5205 / 3067 / 16635 | 5.4% / 8.4% | 68% |
| WOJAK | $1,148,364 | 13446 | 781 / 1827 / 2974 / 1677 / 6187 | 4.9% / 7.6% | 93% |
| WAGMI | $521,960 | 3861 | 0 / 0 / 1006 / 718 / 2137 | 5.0% / 7.8% | 90% |
| PI10 | $506,077 | 6993 | 355 / 1029 / 2264 / 1129 / 2216 | 6.9% / 9.6% | 89% |
| FORGE | $394,829 | 5471 | 189 / 719 / 2144 / 1015 / 1404 | 5.2% / 8.3% | 100% |
| PCAT | $371,132 | 6142 | 387 / 759 / 1593 / 577 / 2826 | 6.6% / 10.1% | 89% |
| ONE | $324,287 | 4099 | 164 / 362 / 659 / 1609 / 1305 | 8.7% / 12.1% | 94% |
| YEE | $246,203 | 3903 | 216 / 647 / 768 / 669 / 1603 | 5.7% / 9.2% | 98% |
| CYBER | $230,687 | 4196 | 144 / 405 / 720 / 423 / 2504 | 5.2% / 8.2% | 91% |
| PEPE | $197,794 | 3572 | 111 / 417 / 501 / 356 / 2187 | 6.7% / 11.1% | 89% |
| DINU | $194,915 | 4321 | 196 / 534 / 802 / 520 / 2269 | 12.7% / 21.2% | 86% |
| OMNI | $171,010 | 2797 | 160 / 471 / 655 / 315 / 1196 | 4.9% / 9.2% | 94% |
| MAKERS | $133,062 | 2054 | 191 / 247 / 621 / 244 / 751 | 9.4% / 13.9% | 27% |
| FLAT | $65,490 | 1239 | 56 / 120 / 310 / 140 / 613 | 6.5% / 9.3% | 81% |
| VBTCV | $12,448 | 242 | 13 / 28 / 63 / 40 / 98 | 6.3% / 9.5% | 100% |
| DACITY | $8,186 | 111 | 11 / 9 / 27 / 10 / 54 | 8.3% / 11.5% | 100% |
| KERMIT | $6,125 | 156 | 7 / 17 / 59 / 16 / 57 | 5.6% / 7.5% | 100% |

## Peluang terbesar yang teramati

| Modal | Koin | Beli → Jual | Snapshot berturut-turut | Ukuran | Net pertama | Net maks |
| --- | --- | --- | --- | --- | --- | --- |
| $2,000 | flat-69afff | solana → ethereum | 3 | $57.77 | $1.89 | $2.00 |
| $10,000 | flat-69afff | solana → ethereum | 3 | $57.77 | $1.89 | $2.00 |
| $50,000 | flat-69afff | solana → ethereum | 3 | $57.77 | $1.89 | $2.00 |
| $500 | flat-69afff | solana → ethereum | 2 | $25.00 | $1.24 | $1.29 |
| $2,000 | yee | solana → base | 3 | $46.06 | $1.19 | $1.27 |
| $10,000 | yee | solana → base | 3 | $46.06 | $1.19 | $1.27 |
| $50,000 | yee | solana → base | 3 | $46.06 | $1.19 | $1.27 |
| $10,000 | pve | solana → ethereum | 2 | $68.59 | $1.05 | $1.06 |
| $50,000 | pve | solana → ethereum | 2 | $68.59 | $1.05 | $1.06 |
| $2,000 | pve | solana → ethereum | 2 | $68.58 | $1.05 | $1.06 |

## Asumsi dan keterbatasan

- **Harga gas** belum dibaca on-chain (RPC Ethereum, Base, BSC dan Solana belum tersedia di lingkungan ini). Dipakai nilai config: ethereum 0.2, base 0.01, robinhood 0.01, bsc 0.1, solana 10000 (gwei untuk EVM, micro-lamports/CU untuk Solana).
- **Fee LayerZero** dari `quoteSend` di Robinhood (ke Base/BSC/Ethereum/Solana) dan contoh di dokumentasi Pangea; rute dari chain lain diasumsikan serupa.
- **Fee hook** diukur di Robinhood saja; diasumsikan sama di Ethereum, Base dan BSC. Pool Solana diasumsikan memakai fee yang sama tanpa fee dinamis/scheduler (belum diverifikasi on-chain).
- **Snapshot `/api/pools`** adalah satu pembacaan bersama yang di-cache Pangea maksimal 60 detik; kelima chain mungkin tidak terbaca di detik yang sama.
- **Harga USD** ETH/BNB/SOL memakai kurs di snapshot Pangea (coinbase + dexscreener + kraken), bukan Chainlink, agar konsisten dengan waktu pembacaan pool.
- Resolusi 5 menit tidak bisa mengukur durasi gap dalam detik; untuk itu dibutuhkan log swap on-chain di kelima chain (RPC).
