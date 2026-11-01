# Fase 0 — Validasi ekonomi arbitrase koin Pangea

_Dibuat otomatis oleh `pnpm phase0` pada 2026-11-01T09:00:55.014Z. Angka berasal dari data on-chain yang dibaca lewat API Pangea dan RPC Robinhood Chain; tidak ada transaksi yang dikirim._

## Ringkasan

**Kesimpulan: pada likuiditas Pangea saat ini, bot arbitrase TRUE belum layak secara ekonomi sebagai sumber profit utama.** Peluang memang ada, tapi kecil, jarang, dan hampir seluruhnya bergantung pada Solana atau Ethereum serta satu-dua koin mikro.

**Angka penting (24 snapshot, 29 Oktober 2026 17:29–19:24 UTC, 25 koin teratas):**

- Pasarnya tipis. Dari 1.006 launch, hanya 21 yang punya likuiditas quote di atas $1.000 (total lima chain) dan hanya 6 di atas $10.000. Sisi token tiap pool rata-rata ~$5.000, sehingga trade $60 saja sudah kena slippage ~2,5%.
- Fee trading koin-koin teratas 0,3%–5% (mayoritas 1–2%). Ditambah fee bridge 0,2%, margin 0,3% dan rebalance 0,1%, sebuah gap baru impas mulai ~2,6% (fee 1%) atau ~4,6% (fee 2%), sebelum gas dan LayerZero.
- Dengan konfigurasi dasar (parameter RANCANGAN 2.3), hanya ada **5 episode peluang berbeda dalam 2 jam** (modal ≥ $2.000; 8 episode pada $500). Median ukuran trade **$59**, median net **$1,37**.
- **Modal besar tidak membantu.** Ukuran trade dibatasi kedalaman pool, bukan modal: hasil untuk modal $2.000, $10.000 dan $50.000 identik. Modal sekitar $2.000 sudah cukup untuk menangkap semua yang ada.
- **Semua peluang melibatkan Solana atau Ethereum.** Dengan hanya Base, BSC dan Robinhood Chain (rencana awal Fase 2) tidak ada satu pun trade yang lolos (skenario `phase2-chains`). Dengan aturan dilonggarkan pun hanya 1 trade senilai $0,26.
- Peluang terkonsentrasi. Hampir semuanya berasal dari FLAT (beli di Solana, jual di Ethereum; gap ~12% yang bertahan seluruh 2 jam) dan YEE (Solana → Base). Market cap keduanya ~$20.400, tepat di batas minimum $20.000.
- PANGEA, satu-satunya koin yang dalam ($303k likuiditas quote, market cap ~$7 juta), dijaga ketat: spread median 2,4%, di bawah titik impas 2,6%. Ini konsisten dengan bot arbitrase milik Pangea sendiri yang aktif di koin itu.

**Perkiraan profit.** Batas bawah dari laporan ini (sekali tangkap per episode, diekstrapolasi) ≈ $85/hari pada modal $2.000. Angka ini rapuh karena hanya 5 episode dalam 2 jam dan didominasi satu gap FLAT yang bertahan lama. Batas atas (gap yang sama ditrade ulang tiap 5 menit) ≈ $1.000/hari dan tidak realistis, karena trade kita sendiri akan mengecilkan gap itu. Jika pesaing (bot PANGEA, ZGAP) memenangkan separuh peluang, batas bawah turun ke ~$40/hari.

**Konfirmasi dari paper trading Fase 1** (1 jam 50 menit, modal virtual $10.000, harga Robinhood dari RPC, chain lain dari `/api/pools`): 44 trade simulasi, expected net +$66, volume $1.615. Namun 40 dari 44 trade adalah gap FLAT dan YEE yang sama, ditrade ulang setiap kali snapshot baru masuk. Angka itu optimistis karena simulator tidak bisa memasukkan dampak trade kita sendiri ke harga pool nyata.

**Yang membuat angka di atas mungkin terlalu rendah:** resolusi 5 menit tidak melihat gap yang muncul dan hilang dalam hitungan detik; gas dan fee LayerZero diambil konservatif; jendela pengamatan hanya 2 jam di satu sore. **Yang membuatnya mungkin terlalu tinggi:** peluang bergantung pada koin di batas market cap minimum, pesaing tidak dimodelkan selain lewat skenario tingkat kemenangan, dan harga ETH/BNB/SOL memakai kurs snapshot Pangea, bukan Chainlink.

**Rekomendasi.**
1. Jangan mulai live hanya di Base/BSC/Robinhood: data menunjukkan tidak ada peluang di sana. Kalau tetap live, sertakan Solana sejak awal (rute keluar Solana murah, LayerZero ~$0,06) dan pertimbangkan Ethereum hanya sebagai chain jual.
2. Modal awal kecil, sekitar $1.000–2.000; menambah modal tidak menambah profit pada likuiditas saat ini.
3. Ulangi pengumpulan data minimal 3 hari dan, bila RPC kelima chain tersedia, ukur gap dari log swap on-chain (resolusi detik) sebelum keputusan modal yang lebih besar.
4. Nilai token $TRUE sebaiknya tidak digantungkan pada profit bot saja; scanner True Score dan alert (RANCANGAN Bagian 4) lebih realistis sebagai penopang utama di tahap ini.

## Data dan metode

| Sumber | Isi | Periode |
| --- | --- | --- |
| `GET /api/pools` tiap 5.0 menit | sqrtPrice, liquidity, tick dan reserves per chain untuk semua launch | 2026-10-29T17:29:17.399Z → 2026-10-29T19:24:25.217Z (24 snapshot, ≈2.0 jam) |
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
| $500 | 8 | 95.9 | 50% | $25.00 | $1.29 | 514 | 10 / 15 | $116.74 – $248.23 | 23.35% – 49.65% |
| $2,000 | 5 | 59.9 | 100% | $58.51 | $1.37 | 279 | 10 / 120 | $84.81 – $996.19 | 4.24% – 49.81% |
| $10,000 | 5 | 59.9 | 100% | $58.51 | $1.37 | 279 | 10 / 120 | $84.94 – $996.31 | 0.85% – 9.96% |
| $50,000 | 5 | 59.9 | 100% | $58.51 | $1.37 | 279 | 10 / 120 | $84.94 – $996.31 | 0.17% – 1.99% |

Dengan asumsi TRUE hanya memenangkan sebagian peluang (pesaing seperti bot $PANGEA dan ZGAP):

| Modal | Menang 100% | Menang 50% | Menang 25% |
| --- | --- | --- | --- |
| $500 | $116.74 – $248.23 | $58.37 – $124.11 | $29.18 – $62.06 |
| $2,000 | $84.81 – $996.19 | $42.41 – $498.10 | $21.20 – $249.05 |
| $10,000 | $84.94 – $996.31 | $42.47 – $498.16 | $21.23 – $249.08 |
| $50,000 | $84.94 – $996.31 | $42.47 – $498.16 | $21.23 – $249.08 |

### Rata-rata komponen biaya per trade yang lolos

| Modal | Fee trading | Slippage | Gas | Fee bridge | LayerZero | Rebalance quote | Margin risiko |
| --- | --- | --- | --- | --- | --- | --- | --- |
| $500 | $0.89 | $0.39 | $0.07 | $0.05 | $0.06 | $0.03 | $0.07 |
| $2,000 | $1.83 | $1.76 | $0.06 | $0.12 | $0.08 | $0.06 | $0.17 |
| $10,000 | $1.84 | $1.77 | $0.06 | $0.12 | $0.08 | $0.06 | $0.17 |
| $50,000 | $1.84 | $1.77 | $0.06 | $0.12 | $0.08 | $0.06 | $0.17 |

### Pasangan chain yang paling sering memberi peluang (modal terbesar)

| Beli → Jual | Episode |
| --- | --- |
| solana→ethereum | 3 |
| ethereum→solana | 1 |
| solana→base | 1 |

## Skenario sensitivitas

### batched-rebalance

LayerZero fee shared by 10 trades (inventory rebalanced in batches).

| Modal | Episode | Episode/hari | % snapshot ada peluang | Median ukuran | Median net | Median net (bps) | Bertahan p50 / max (menit) | Net/hari (bawah – atas) | ROI/hari |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| $500 | 13 | 155.8 | 54% | $25.00 | $1.08 | 433 | 10 / 15 | $183.48 – $345.67 | 36.70% – 69.13% |
| $2,000 | 9 | 107.9 | 100% | $59.13 | $1.42 | 282 | 15 / 120 | $173.05 – $1,265.55 | 8.65% – 63.28% |
| $10,000 | 9 | 107.9 | 100% | $59.13 | $1.42 | 282 | 15 / 120 | $173.17 – $1,265.68 | 1.73% – 12.66% |
| $50,000 | 9 | 107.9 | 100% | $59.13 | $1.42 | 282 | 15 / 120 | $173.17 – $1,265.68 | 0.35% – 2.53% |

### batched-low-min

batched rebalance and minimum net profit lowered to $0.25.

| Modal | Episode | Episode/hari | % snapshot ada peluang | Median ukuran | Median net | Median net (bps) | Bertahan p50 / max (menit) | Net/hari (bawah – atas) | ROI/hari |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| $500 | 41 | 491.4 | 100% | $25.00 | $0.54 | 217 | 10 / 65 | $311.43 – $686.32 | 62.29% – 137.26% |
| $2,000 | 19 | 227.7 | 100% | $56.55 | $1.30 | 212 | 10 / 120 | $167.98 – $1,563.55 | 8.40% – 78.18% |
| $10,000 | 18 | 215.8 | 100% | $56.55 | $1.31 | 212 | 10 / 120 | $164.39 – $1,560.08 | 1.64% – 15.60% |
| $50,000 | 18 | 215.8 | 100% | $56.55 | $1.31 | 212 | 10 / 120 | $164.39 – $1,560.08 | 0.33% – 3.12% |

### phase2-chains

only Base, BSC and Robinhood Chain may be traded (the Phase 2 starting set).

| Modal | Episode | Episode/hari | % snapshot ada peluang | Median ukuran | Median net | Median net (bps) | Bertahan p50 / max (menit) | Net/hari (bawah – atas) | ROI/hari |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| $500 | 0 | 0.0 | 0% | – | – | – | – | $0.00 – $0.00 | 0.00% – 0.00% |
| $2,000 | 0 | 0.0 | 0% | – | – | – | – | $0.00 – $0.00 | 0.00% – 0.00% |
| $10,000 | 0 | 0.0 | 0% | – | – | – | – | $0.00 – $0.00 | 0.00% – 0.00% |
| $50,000 | 0 | 0.0 | 0% | – | – | – | – | $0.00 – $0.00 | 0.00% – 0.00% |

### phase2-chains-batched

Base, BSC and Robinhood only, with batched rebalance and a $0.25 minimum.

| Modal | Episode | Episode/hari | % snapshot ada peluang | Median ukuran | Median net | Median net (bps) | Bertahan p50 / max (menit) | Net/hari (bawah – atas) | ROI/hari |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| $500 | 0 | 0.0 | 0% | – | – | – | – | $0.00 – $0.00 | 0.00% – 0.00% |
| $2,000 | 1 | 12.0 | 4% | $34.89 | $0.26 | 74 | 5 / 5 | $3.10 – $3.10 | 0.15% – 0.15% |
| $10,000 | 1 | 12.0 | 4% | $34.89 | $0.26 | 74 | 5 / 5 | $3.10 – $3.10 | 0.03% – 0.03% |
| $50,000 | 1 | 12.0 | 4% | $34.89 | $0.26 | 74 | 5 / 5 | $3.10 – $3.10 | 0.01% – 0.01% |

## Per koin (snapshot terakhir dan sepanjang jendela)

Breakeven = gap minimum agar trade kecil impas (2 × fee + fee bridge + margin + rebalance), sebelum gas, LayerZero dan slippage.

| Koin | Fee | Likuiditas quote (5 chain) | Market cap | Spread sekarang | True Score | Spread p50 / p90 | Breakeven | % snapshot bisa dieksekusi* | Alasan penolakan utama |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PANGEA | 1.0% | $303,367 | $7,075,767 | 2.5% | 50 | 2.4% / 3.2% | 2.6% | 0% | net profit # < # |
| ONECOIN | 1.0% | $43,281 | $227,220 | 2.9% | 41 | 3.7% / 5.0% | 2.6% | 0% | net profit # < # |
| ZGAP | 1.0% | $23,264 | $97,507 | 1.1% | 78 | 4.3% / 6.3% | 2.6% | 4% | net profit # < # |
| PVE | 2.0% | $25,488 | $110,668 | 5.9% | 0 | 7.1% / 8.5% | 4.6% | 17% | net profit # < # |
| WAGMI | 2.0% | $18,285 | $151,734 | 3.4% | 32 | 5.0% / 5.2% | 4.6% | 0% | net profit # < # |
| WOJAK | 1.0% | $12,902 | $51,401 | 5.4% | 0 | 7.0% / 7.9% | 2.6% | 0% | net profit # < # |
| PCAT | 2.0% | $6,267 | $29,456 | 6.3% | 0 | 6.3% / 6.3% | 4.6% | 0% | net profit # < # |
| CYBER | 1.0% | $5,443 | $27,216 | 1.8% | 63 | 1.8% / 1.9% | 2.6% | 0% | – |
| MAKERS | 5.0% | $3,816 | $23,727 | 8.7% | 0 | 8.7% / 9.3% | 10.6% | 0% | – |
| PEPE | 2.0% | $3,710 | $22,505 | 6.3% | 0 | 6.0% / 6.3% | 4.6% | 0% | net profit # < # |
| FLAT | 2.0% | $2,824 | $20,409 | 12.8% | 0 | 12.6% / 12.7% | 4.6% | 100% | – |
| YEE | 1.0% | $2,764 | $20,666 | 7.6% | 0 | 8.5% / 8.7% | 2.6% | 92% | net profit # < # |
| VBTCV | 1.0% | $1,978 | $18,711 | 6.2% | 0 | 10.5% / 10.5% | 2.6% | 0% | market cap below minimum |
| OMNI | 1.0% | $2,153 | $18,879 | 6.9% | 0 | 6.9% / 6.9% | 2.6% | 0% | market cap below minimum |
| ONE | 2.0% | $1,674 | $17,657 | 8.5% | 0 | 8.5% / 8.8% | 4.6% | 0% | market cap below minimum |
| FORGE | 1.0% | $1,420 | $17,987 | 5.7% | 0 | 5.5% / 5.7% | 2.6% | 0% | market cap below minimum |
| KERMIT | 0.3% | $1,246 | $16,795 | 4.9% | 2 | 4.9% / 5.2% | 1.2% | 0% | market cap below minimum |
| DINU | 3.0% | $1,128 | $5,570 | 9.2% | 0 | 13.4% / 27.7% | 6.6% | 0% | market cap below minimum |
| PI10 | 2.0% | $1,134 | $19,784 | 9.9% | 0 | 9.6% / 9.8% | 4.6% | 0% | market cap below minimum |
| DACITY | 2.0% | $1,027 | $16,229 | 12.1% | 0 | 12.1% / 12.2% | 4.6% | 0% | market cap below minimum |
| 1NU | 0.3% | $1,021 | $16,761 | 5.6% | 0 | 5.9% / 6.0% | 1.2% | 0% | market cap below minimum |
| ASTEROID | 1.0% | $979 | $16,338 | 2.3% | 53 | 2.3% / 2.3% | 2.6% | 0% | market cap below minimum |
| DRIFT | 1.0% | $964 | $17,182 | 11.7% | 0 | 11.3% / 11.6% | 2.6% | 0% | market cap below minimum |
| CHAT | 0.3% | $933 | $16,116 | 5.1% | 0 | 4.8% / 5.0% | 1.2% | 0% | market cap below minimum |
| WPC | 1.0% | $896 | $5,049 | 3.9% | 22 | 3.8% / 3.9% | 2.6% | 0% | market cap below minimum |

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
| $2,000 | flat-69afff | solana → ethereum | 24 | $57.77 | $1.89 | $2.19 |
| $10,000 | flat-69afff | solana → ethereum | 24 | $57.77 | $1.89 | $2.19 |
| $50,000 | flat-69afff | solana → ethereum | 24 | $57.77 | $1.89 | $2.19 |
| $10,000 | zgap | ethereum → solana | 1 | $106.29 | $1.86 | $1.86 |
| $50,000 | zgap | ethereum → solana | 1 | $106.29 | $1.86 | $1.86 |
| $2,000 | zgap | ethereum → solana | 1 | $100.00 | $1.85 | $1.85 |
| $500 | flat-69afff | solana → ethereum | 3 | $25.00 | $1.34 | $1.35 |
| $500 | flat-69afff | solana → ethereum | 2 | $25.00 | $1.32 | $1.32 |
| $500 | flat-69afff | solana → ethereum | 2 | $25.00 | $1.29 | $1.31 |
| $500 | flat-69afff | solana → ethereum | 2 | $25.00 | $1.27 | $1.29 |
| $500 | flat-69afff | solana → ethereum | 1 | $25.00 | $1.24 | $1.24 |
| $500 | flat-69afff | solana → ethereum | 2 | $25.00 | $1.24 | $1.29 |
| $2,000 | yee | solana → base | 22 | $46.06 | $1.19 | $1.37 |
| $10,000 | yee | solana → base | 22 | $46.06 | $1.19 | $1.37 |
| $50,000 | yee | solana → base | 22 | $46.06 | $1.19 | $1.37 |

## Asumsi dan keterbatasan

- **Harga gas** belum dibaca on-chain (RPC Ethereum, Base, BSC dan Solana belum tersedia di lingkungan ini). Dipakai nilai config: ethereum 0.2, base 0.01, robinhood 0.01, bsc 0.1, solana 10000 (gwei untuk EVM, micro-lamports/CU untuk Solana).
- **Fee LayerZero** dari `quoteSend` di Robinhood (ke Base/BSC/Ethereum/Solana) dan contoh di dokumentasi Pangea; rute dari chain lain diasumsikan serupa.
- **Fee hook** diukur di Robinhood saja; diasumsikan sama di Ethereum, Base dan BSC. Pool Solana diasumsikan memakai fee yang sama tanpa fee dinamis/scheduler (belum diverifikasi on-chain).
- **Snapshot `/api/pools`** adalah satu pembacaan bersama yang di-cache Pangea maksimal 60 detik; kelima chain mungkin tidak terbaca di detik yang sama.
- **Harga USD** ETH/BNB/SOL memakai kurs di snapshot Pangea (coinbase + dexscreener + kraken), bukan Chainlink, agar konsisten dengan waktu pembacaan pool.
- Resolusi 5 menit tidak bisa mengukur durasi gap dalam detik; untuk itu dibutuhkan log swap on-chain di kelima chain (RPC).
