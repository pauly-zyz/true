# TRUE ($TRUE)

Riset arbitrase lintas 5 chain (Ethereum, Base, Robinhood Chain, BSC, Solana) untuk koin-koin
Pangea, bot paper trading, dan scanner harga **True Score**. Rancangan: [docs/RANCANGAN.md](docs/RANCANGAN.md).

> **Default selalu dry run.** Transaksi hanya bisa dikirim oleh `packages/executor` (Fase 2), dan hanya
> bila `DRY_RUN=false` **dan** `LIVE_CONFIRM=yes`. `pnpm safety:check` menolak kode penandatanganan di
> luar `packages/executor` dan hanya mengizinkan `apps/live` mengimpornya.

Hasil Fase 0: [reports/phase0.md](reports/phase0.md).

## Struktur

```
config/default.yaml     semua parameter (chain, alamat kontrak, biaya, risiko, simulator, Fase 0)
db/migrations/          skema Postgres/TimescaleDB
docs/RANCANGAN.md       rancangan produk
packages/core           matematika pool (Uniswap v4, Meteora DAMM v2), biaya, optimizer, risiko,
                        True Score, statistik gap, pemindai peluang, simulator paper trading
packages/chains         klien /api/pools, model pool dari snapshot, klien EVM read-only, watcher
                        Swap/akun Solana, inferensi fee hook, oracle Chainlink, penulisan DB
apps/scripts            Fase 0: pengumpulan data, analisis, laporan; migrasi DB
apps/indexer            Fase 1: menyimpan setiap swap pool yang dipantau ke Postgres
apps/bot                Fase 1: Price & Gap Engine + simulator mode inventaris + CLI dashboard
packages/executor       Fase 2: satu-satunya kode yang boleh menandatangani (swap v4 via Universal
                        Router, simulasi, receipt, Permit2, bridge OFT, rebalance, executor dua leg)
apps/live               Fase 2: bot live/dry run, preflight, Telegram, kill/resume
test/fork               Fase 2: test integrasi di fork mainnet (anvil, atau Hardhat bila anvil tidak ada)
```

## Setup

Butuh Node.js ≥ 22, pnpm 10, dan Postgres 16 (TimescaleDB disarankan; tanpa ekstensi itu tabel
dibuat sebagai tabel biasa).

```bash
pnpm install
```

```bash
cp .env.example .env
```

Isi `.env` (file ini di-`.gitignore`, jangan di-commit):

- `DATABASE_URL`: koneksi Postgres.
- `RPC_HTTP_<CHAIN>` / `RPC_WS_<CHAIN>`: endpoint RPC per chain (`ETHEREUM`, `BASE`, `ROBINHOOD`,
  `BSC`, `SOLANA`). Chain tanpa RPC tetap berjalan memakai pembacaan `/api/pools` (lebih lambat,
  ditandai `snap` di CLI). Untuk Robinhood ada endpoint publik `https://rpc.mainnet.chain.robinhood.com`
  (dibatasi rate).

Database lewat Docker:

```bash
docker compose up -d db
```

```bash
pnpm db:migrate
```

Di balik proxy HTTPS (mis. sandbox cloud), `fetch` milik Node perlu `NODE_USE_ENV_PROXY=1`
(Node ≥ 22.21) agar memakai `HTTPS_PROXY`.

## Fase 0: validasi

Kumpulkan data (semua read-only, hemat panggilan sesuai permintaan Pangea):

```bash
pnpm --filter @true/scripts phase0:collect 24
```

Menyimpan satu pembacaan `/api/pools` tiap `pangea.poolsRefreshSec` (default 5 menit) ke
`data/phase0/snapshots/`.

```bash
pnpm --filter @true/scripts phase0:fees 25
```

Mengukur trading fee 25 koin teratas dari transaksi nyata di Robinhood Chain (butuh `RPC_HTTP_ROBINHOOD`).
Fee tidak tersedia di API Pangea; koin tanpa fee terukur tidak pernah diperdagangkan.

```bash
pnpm --filter @true/scripts phase0:history 20 168
```

Satu panggilan `/api/history` per koin (batas Pangea: 30 per 10 menit).

Lalu analisis dan laporan (tanpa jaringan):

```bash
pnpm phase0
```

Menulis `data/phase0/analysis.json` dan `reports/phase0.md`. Kesimpulan yang ditulis manusia ada di
`reports/phase0-notes.md` dan disisipkan ke laporan.

## Fase 1: paper trading

```bash
pnpm bot
```

Memantau pool, menghitung harga USD, spread dan True Score per koin setiap ada update, lalu
mensimulasikan trade mode inventaris dengan saldo virtual (`simulator.startingCapitalUsd`) dan
parameter risiko RANCANGAN 2.3. Semua trade simulasi (dan penolakan yang relevan) dicatat ke
`sim_trades`, ekuitas ke `sim_pnl`, snapshot gap ke `gap_snapshots`.

```bash
pnpm cli
```

Dashboard terminal yang refresh tiap 2 detik: gap live, trade simulasi, PnL virtual. `pnpm cli --once`
mencetak sekali.

```bash
pnpm indexer
```

Opsional: hanya menyimpan setiap swap pool yang dipantau ke tabel `swaps`.

## Fase 2: eksekusi live (modal kecil)

Chain live diatur di `config/default.yaml` bagian `live.chains`: Base, BSC dan Robinhood aktif; Solana
dan Ethereum mati sampai dinyalakan manual (eksekusi Solana belum dibangun).

1. Isi RPC, wallet bot per chain (`BOT_PK_<CHAIN>`) dan Telegram di `.env`.
2. Cek semua prasyarat (read-only; harus lulus semua):

```bash
pnpm live:preflight
```

3. Uji di fork mainnet (anvil bila terpasang, kalau tidak Hardhat):

```bash
pnpm test:fork
```

4. Jalankan dalam dry run: semua langkah nyata (quote, simulasi `eth_call`, pencatatan) kecuali broadcast.

```bash
pnpm live
```

5. Live hanya dengan `DRY_RUN=false` dan `LIVE_CONFIRM=yes` di `.env`, dinyalakan oleh manusia.

Kontrol: kill switch (`pnpm live:kill [alasan]`, `/kill` di Telegram, atau file `data/KILL`),
`pnpm live:resume <koin>` setelah leg gagal, circuit breaker rugi harian 3% (menulis kill file,
butuh restart manual). ETH/BNB tidak dipindah otomatis; bot hanya mengirim alert saldo menipis.
Semua trade, leg, bridge, saldo dan kejadian risiko tercatat di tabel `live_*` dan `risk_events`.

## Pengujian

```bash
pnpm check
```

Menjalankan typecheck, lint, seluruh test (vitest) dan safety check; gagal bila salah satunya gagal.

Cakupan test utama:

- Matematika Uniswap v4 (TickMath, SqrtPriceMath, SwapMath, swap multi-tick) dengan vektor dari
  test resmi v4-core.
- Matematika Meteora DAMM v2 dibandingkan langsung dengan fungsi SDK resmi.
- Golden test dua transaksi PANGEA nyata di Robinhood (fee hook 1%) yang cocok sampai ke wei.
- Model pool dari snapshot `/api/pools` nyata: harga dan reserves cocok dengan Pangea di 5 chain.
- Model biaya dan optimizer: biaya > profit, gas dan LayerZero Ethereum, slippage besar, pembulatan
  bridge 6 desimal, batas 2% pool, batas eksposur, circuit breaker.
- Simulator: alokasi, perpindahan saldo, cooldown, inventaris kurang, circuit breaker, rebalance.
- ABI yang ditulis tangan dibandingkan dengan artefak resmi Uniswap.

## Temuan teknis penting

- **Fee dipungut hook, bukan pool.** Pool EVM Pangea di-*initialize* dengan LP fee 0 dan sebuah hook
  (izin `beforeSwap`/`afterSwap` dengan return delta). Hook mengambil fee dalam ETH/BNB: dari input
  saat beli, dari output saat jual. Ini diverifikasi on-chain di Robinhood, padahal dokumentasi
  Pangea menyebut launch Standard "tanpa hook".
- **Satu posisi per pool.** Setiap pool v4 berisi satu posisi terkunci `[tick minimum, tickUpper]`;
  `tickUpper` bisa diturunkan dari reserves di `/api/pools` dan cocok persis dengan on-chain.
- **Fee LayerZero ditentukan chain tujuan**: ke Ethereum ~$1,8, ke Solana ~$1,0, ke Base/BSC ~$0,26,
  keluar dari Solana ~$0,06 (diukur dengan `quoteSend`).
