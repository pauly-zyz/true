# TRUE ($TRUE): Rancangan Produk

> **One true price.**
> Bot arbitrase yang menjaga harga koin-koin Pangea tetap "rata" di lima chain, dijadikan satu koin. Profitnya kembali ke likuiditas, holder, dan bot itu sendiri.

| | |
|---|---|
| **Nama** | TRUE |
| **Ticker** | $TRUE |
| **Teknologi bot & scanner** | Dirancang untuk ekosistem Pangea (pangea.trade): memantau dan mengarbitrase koin-koin Pangea |
| **Chain operasi bot** | Ethereum, Base, Robinhood Chain, BSC, Solana |
| **Launch token $TRUE** | **Pons V2, Robinhood Chain** (token hanya ada di satu chain) |
| **Status** | Rancangan v0.2 (28 Oktober 2026) |

---

## 1. Ringkasan

Setiap koin di Pangea hidup di lima chain sekaligus, masing-masing dengan pool sendiri. Harga di kelima pool itu **tidak disatukan oleh mekanisme apa pun**. Yang menyatukannya hanya arbitrase, yang terbuka untuk siapa saja. Akibatnya, selisih harga antar-chain (gap) terus muncul setiap kali ada transaksi besar di satu chain.

**TRUE** adalah bot yang memburu gap tersebut: ia membeli di chain yang murah, mem-bridge, lalu menjual di chain yang mahal. Profit bersihnya dibagi tiga:

- untuk memperdalam likuiditas $TRUE,
- untuk dibagikan ke holder dalam bentuk ETH,
- dan untuk menambah modal bot.

> **Pemisahan penting.** *Teknologi* TRUE dirancang untuk Pangea: bot dan scanner bekerja pada koin-koin Pangea di lima chain. *Token* $TRUE sendiri **tidak** diluncurkan di Pangea. Token ini diluncurkan di **Pons V2** dan hanya ada di **Robinhood Chain**.

Selain bot, TRUE menyediakan **scanner publik** yang memberi setiap koin Pangea sebuah **True Score**, yaitu ukuran seberapa rata harganya di lima chain. Holder $TRUE mendapat akses premium ke data real-time dan alert.

### Pembeda dari ZGAP

| | ZGAP | TRUE |
|---|---|---|
| Token | Diluncurkan di Pangea, 5 chain | Diluncurkan di Pons V2, Robinhood Chain saja |
| Pemakaian profit | 30% buyback & burn, 70% modal | 35% buyback $TRUE di Robinhood Chain, 25% reward ETH ke holder, 40% modal |
| Kegunaan token | Hanya buyback | Akses premium scanner, alert, dan reward holder |
| Data | Statistik bot sendiri | Scanner publik untuk semua koin Pangea (True Score) |
| Transparansi | Halaman statistik | Wallet bot dipublikasikan + laporan mingguan |
| Visual | Gelap, teal, lempeng tektonik | Terang, hangat, waterpass |

---

## 2. Cara kerja bot

### 2.1 Siklus utama

```
DETEKSI  →  HITUNG  →  EKSEKUSI  →  REBALANCE  →  BAGI PROFIT
```

1. **Deteksi.** Bot memantau event swap di pool setiap koin Pangea di kelima chain:
   - Uniswap v4 di Ethereum, Base, Robinhood Chain, dan BSC;
   - Meteora DAMM v2 di Solana.

   Begitu sebuah swap menggeser harga, bot menghitung ulang selisih harga dalam USD antar-chain.

2. **Hitung.** Gap hanya dieksekusi kalau perkiraan profit bersihnya positif setelah dikurangi semua biaya berikut:

   | Komponen biaya | Besaran |
   |---|---|
   | Trading fee pool beli + pool jual | 0,3–5% per sisi (ditentukan masing-masing koin) |
   | Fee bridge token | 0,2% dari jumlah yang di-bridge |
   | Fee pesan LayerZero | Dibayar dalam aset native chain asal |
   | Gas di dua chain | Bervariasi; Ethereum paling mahal |
   | Slippage di dua pool | Dihitung dari kedalaman pool |
   | Margin risiko | Parameter, misalnya 0,3% |

3. **Eksekusi.** Bot punya dua mode:
   - **Mode inventaris (utama):** bot sudah memegang stok token di chain mahal dan aset quote di chain murah. Ia membeli di chain murah dan menjual di chain mahal **pada saat yang sama**, tanpa menunggu bridge. Ini yang membuat gap bisa ditutup dalam hitungan detik.
   - **Mode bridge:** dipakai kalau stok di chain mahal tidak cukup. Bot membeli, mem-bridge (biasanya 4–16 detik antar chain non-Ethereum), lalu menjual. Mode ini lebih lambat dan lebih berisiko.

4. **Rebalance.** Secara berkala bot mem-bridge stok token ke chain yang kekurangan, dan memindahkan aset quote (ETH/BNB/SOL) ke chain yang membutuhkan.

5. **Bagi profit.** Profit yang sudah terealisasi dicatat per periode, lalu dibagi sesuai Bagian 3.

### 2.2 Strategi bersaing

TRUE akan berebut gap yang sama dengan bot arbitrase lain, termasuk ZGAP. Strateginya:

- **Gap besar:** fokus pada gap yang butuh modal besar untuk ditutup penuh. Bot pesaing dengan modal terbatas hanya menutup sebagian.
- **Koin baru:** cepat masuk ke koin yang baru launch, sebelum bot lain menambahkannya ke daftar pantauan.
- **Kecepatan:** WebSocket langsung ke node, tanpa melewati API pihak ketiga.
- **Prioritas chain murah:** Base, BSC, dan Robinhood Chain lebih dulu; Ethereum hanya untuk gap besar.

### 2.3 Parameter risiko

| Parameter | Nilai awal (contoh) |
|---|---|
| Profit bersih minimum per trade | $1 dan ≥ 0,3% |
| Ukuran trade maksimum | 2% dari likuiditas pool terkecil di antara dua sisi |
| Eksposur maksimum per koin | 5% dari modal bot |
| Market cap minimum koin | $20.000 |
| Kerugian harian maksimum (circuit breaker) | 3% dari modal, lalu bot berhenti otomatis |
| Koin yang dikecualikan | Koin dengan tanda bahaya (lihat 4.3) |

---

## 3. Tokenomics

### 3.1 Launch di Pons V2 (Robinhood Chain)

$TRUE diluncurkan di **Pons V2** dan hanya ada di **Robinhood Chain**. Bot tetap beroperasi di lima chain Pangea; yang satu chain hanya tokennya.

| Pengaturan | Pilihan |
|---|---|
| Platform | Pons V2 |
| Chain | Robinhood Chain saja |
| Pasangan quote | ETH atau USDG (sesuai opsi yang tersedia di Pons) |
| Fase awal | Token mulai di bonding curve Pons, lalu *graduate* ke pool DEX |
| Dev buy | Opsional, untuk modal awal bot. Jumlahnya diumumkan terbuka |

> **Perlu dicek:** rancangan ini belum memetakan detail mekanisme Pons, yaitu biaya launch, fee trading, bagian untuk kreator, aturan bonding curve dan graduation, serta apakah likuiditas setelah graduation terkunci dan bisa ditambah dari luar. Pelajari dokumentasi Pons sebelum mengunci angka-angka di bawah.

### 3.2 Fee kreator dari Pons

Fitur vault tokenomics milik Pangea **tidak berlaku**, karena $TRUE tidak diluncurkan di Pangea. Jika Pons memberi bagian fee trading ke kreator, alokasinya dijalankan sendiri oleh distributor TRUE. Usulan:

| Porsi | Tujuan |
|---|---|
| 50% | Buyback $TRUE |
| 30% | Modal bot |
| 20% | Operasional (server, RPC, pengembangan) |

### 3.3 Pembagian profit bot

| Porsi | Tujuan | Mekanisme |
|---|---|---|
| **35%** | Buyback $TRUE | Membeli $TRUE di Robinhood Chain, lalu dibakar atau ditambahkan ke likuiditas (lihat 3.5) |
| **25%** | Reward holder | Dibagikan dalam ETH di Robinhood Chain ke holder $TRUE setiap minggu |
| **40%** | Modal bot | Tetap di bot, di chain masing-masing, untuk menutup gap yang lebih besar |

Selama $TRUE masih di bonding curve, buyback dilakukan lewat curve, sehingga ikut mendorong token menuju graduation. Setelah graduate, buyback dilakukan lewat pool DEX.

### 3.4 Konsolidasi profit ke Robinhood Chain

Profit bot tersebar di lima chain dalam bentuk ETH (Ethereum, Base, Robinhood Chain), BNB (BSC), dan SOL (Solana). Padahal buyback dan reward terjadi di Robinhood Chain. Karena itu, setiap minggu distributor:

1. Menghitung profit bersih per chain.
2. Menyisihkan porsi modal bot (40%) di chain masing-masing.
3. Menukar sisanya (60%): BNB dan SOL ditukar ke ETH, lalu semuanya dipindahkan ke Robinhood Chain lewat bridge yang andal.
4. Menjalankan buyback dan reward di Robinhood Chain.

Biaya swap dan bridge ini dikurangkan dari profit sebelum dibagi. Konsolidasi dilakukan mingguan, bukan per trade, supaya biayanya kecil.

### 3.5 Buyback: dibakar atau ditambahkan ke likuiditas?

- **Burn (default):** sederhana dan pasti bisa dilakukan.
- **Tambah likuiditas:** hanya jika pool $TRUE setelah graduation di Pons menerima likuiditas dari luar dan likuiditas itu bisa dikunci.

Gunakan burn sampai aturan Pons sudah dipastikan.

### 3.6 Reward holder

Karena $TRUE hanya ada di Robinhood Chain, reward cukup dibagikan lewat **satu kontrak klaim Merkle di Robinhood Chain**:

- Snapshot holder diambil setiap minggu, lalu reward dibagi proporsional dan diklaim sendiri oleh holder. Gas di Robinhood Chain murah.
- **Batas minimum holding**, misalnya 0,05% supply, untuk mencegah spam wallet.
- **Alamat yang dikecualikan:** bonding curve/pool, wallet tim, dan wallet bot.
- **Anti snapshot-gaming:** pakai rata-rata saldo selama satu minggu, bukan saldo pada satu titik waktu.

---

## 4. Produk: scanner True Score

### 4.1 True Score

Setiap koin Pangea mendapat skor 0–100 yang menunjukkan seberapa rata harganya di kelima chain.

```
spread    = (harga tertinggi − harga terendah) / harga terendah
TrueScore = max(0, 100 − spread_dalam_persen × 20)
```

Contoh: spread 0% menghasilkan skor 100, spread 1% skor 80, dan spread 5% atau lebih skor 0.
Formula ini masih awal dan bisa diberi bobot tambahan untuk kedalaman likuiditas.

### 4.2 Tingkatan akses

| Fitur | Publik | Holder $TRUE |
|---|---|---|
| Daftar koin + True Score | ✓ (delay 5 menit) | ✓ real-time |
| Harga per chain | ✓ | ✓ |
| Riwayat spread | 24 jam | 30 hari |
| Kalkulator "beli/jual di chain mana" | — | ✓ |
| Peringatan exit liquidity per chain | — | ✓ |
| Alert Telegram (gap bertahan, likuiditas terkuras, launch baru) | — | ✓ |
| Alert khusus koin di wallet sendiri | — | ✓ |

Akses holder diverifikasi dengan **sign-in wallet EVM (SIWE)**. Saldo $TRUE dibaca dari **Robinhood Chain**, satu-satunya chain tempat token ini ada. Scanner-nya sendiri tetap menampilkan data koin Pangea di kelima chain.

| Tingkat | Saldo minimum (contoh) |
|---|---|
| Basic | 0,05% supply |
| Pro | 0,2% supply |

### 4.3 Peringatan exit liquidity

Setiap pool hanya bisa membayar penjual dari cadangannya sendiri. Artinya chain yang sepi pembeli bisa kekurangan aset quote, walaupun likuiditas di chain lain melimpah. Scanner menghitung:

> "Jika 10% token di chain X dijual, harga di chain X turun sekian persen."

Koin diberi tanda ⚠️ di chain yang rawan.

---

## 5. Halaman statistik live

Berfungsi sebagai alat transparansi sekaligus alat pemasaran.

**Hero:**
- Gauge waterpass besar dengan lima gelembung (satu per chain). Gelembung bergeser saat ada gap terdeteksi, lalu kembali ke tengah dengan tanda ✓ saat gap ditutup.
- Status langsung, misalnya: *"Making PEPE true on Base ↔ Robinhood…"*

**Counter:**
- *Prices made true*: hari ini dan total
- *Waktu tutup rata-rata*
- *Profit bersih*: hari ini dan total
- *ETH dibagikan ke holder*: total
- *$TRUE dibeli kembali*: total

**Panel $TRUE (Robinhood Chain):**
- Total $TRUE yang dibeli kembali dan dibakar (atau ditambahkan ke likuiditas)
- Progres bonding curve Pons sampai graduation
- Hitung mundur ke distribusi mingguan berikutnya
- Alamat kontrak $TRUE dengan link ke halaman Pons dan explorer Robinhood Chain

**Feed trade terbaru:**
Koin, chain beli → chain jual, ukuran, profit, dan link transaksi.

**Wallet bot:**
Alamat bot di kelima chain, dengan link ke explorer masing-masing.

---

## 6. Identitas visual

| Elemen | Arahan |
|---|---|
| Tema | Waterpass / spirit level: rata, presisi, lurus |
| Palet | Krem `#F6F1E7`, tinta gelap `#1B1A17`, kuning gelembung `#F2C230`, hijau "true" `#2E9E6A` |
| Mode | Terang sebagai default (kebalikan dari ZGAP yang gelap) |
| Tipografi | Sans geometris untuk judul, monospace untuk angka dan alamat |
| Logo | Gelembung waterpass berbentuk kapsul dengan garis tengah, gelembungnya tepat di tengah |
| Animasi khas | Gelembung bergoyang lalu berhenti di tengah, diikuti centang ✓ |
| Warna chain | Ethereum `#8C8DFB`, Base `#2F7CFF`, Robinhood `#35E07A`, BSC `#F0B90B`, Solana `#9945FF` (konsisten dengan Pangea) |

**Tagline:**
- Utama: *"One true price."*
- Alternatif: *"Five chains. One true price."* / *"Every coin, priced true."*

---

## 7. Arsitektur teknis

```
                ┌───────────────────────────────┐
                │      Indexer (per chain)      │
 RPC WebSocket ─┤  swap events, pool state      │
 (5 chain)      │  Uniswap v4 / Meteora DAMM v2 │
                └──────────────┬────────────────┘
                               │
                ┌──────────────▼────────────────┐
                │      Price & Gap Engine       │
                │  harga USD, spread, TrueScore │
                └───────┬───────────────┬───────┘
                        │               │
        ┌───────────────▼───┐   ┌───────▼─────────────┐
        │   Arbitrage Bot   │   │   Scanner + Alert   │
        │ eksekusi, risiko, │   │ API, Telegram bot,  │
        │ rebalance         │   │ web dashboard       │
        └───────┬───────────┘   └───────┬─────────────┘
                │                       │
        ┌───────▼───────────────────────▼───────┐
        │       Postgres / TimescaleDB          │
        │  trade, profit, spread, holder        │
        └───────┬───────────────────────────────┘
                │
        ┌───────▼───────────────┐
        │  Distributor mingguan │
        │ konsolidasi→Robinhood │
        │ buyback Pons, Merkle  │
        └───────────────────────┘
```

| Lapisan | Teknologi |
|---|---|
| Bahasa | TypeScript (Node.js) |
| EVM | viem, WebSocket RPC per chain |
| Solana | @solana/web3.js, Meteora DAMM v2 SDK |
| Bridge | LayerZero OFT (`quoteOFT`, `quoteSend`, `send`), atau `POST /api/bridge/quote` milik Pangea |
| Daftar koin | `GET /api/pools` milik Pangea. **Hanya untuk metadata dan alamat token, bukan untuk harga real-time** (data dibaca ulang paling lambat tiap 60 detik, dan Pangea meminta API-nya tidak di-crawl) |
| Token $TRUE | Kontrak Pons V2 di Robinhood Chain (bonding curve, lalu pool DEX setelah graduation). ABI dan alamat diambil dari dokumentasi resmi Pons |
| Database | Postgres + TimescaleDB |
| Web | Next.js |
| Telegram | grammY |
| Infrastruktur | VPS dekat node RPC, process manager, monitoring + alert ke tim |

**Keamanan kunci:**
- Wallet bot terpisah per chain, hanya berisi modal kerja.
- Treasury disimpan di Safe (multisig).
- Kunci privat tidak pernah disimpan di repo, dan dikelola lewat secret manager.

---

## 8. Roadmap

| Fase | Isi | Target |
|---|---|---|
| **0. Validasi** | Ukur gap historis (berapa sering, berapa besar, berapa lama bertahan) dari data on-chain. Hitung perkiraan profit setelah biaya | Minggu 1–2 |
| **1. Bot (paper trading)** | Indexer 5 chain + engine gap + simulasi eksekusi tanpa uang sungguhan | Minggu 2–4 |
| **2. Bot live (modal kecil)** | Mulai dari Base ↔ BSC ↔ Robinhood Chain, lalu Solana, lalu Ethereum | Minggu 4–6 |
| **3. Launch $TRUE** | Launch di Pons V2 (Robinhood Chain) + halaman statistik live + publikasi wallet bot | Minggu 6 |
| **4. Scanner** | True Score publik, akses holder, alert Telegram | Minggu 7–9 |
| **5. Reward holder** | Konsolidasi profit ke Robinhood Chain + kontrak klaim Merkle di Robinhood Chain + distribusi mingguan pertama | Minggu 9–10 |

> Launch token **setelah** bot terbukti profit secara live. Halaman statistik yang sudah punya angka nyata di hari pertama jauh lebih meyakinkan daripada janji.

---

## 9. Risiko

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Persaingan dengan ZGAP dan bot lain | Gap habis sebelum TRUE sempat masuk | Fokus pada gap besar, koin baru, dan kecepatan; validasi di Fase 0 |
| Gap makin kecil seiring waktu | Profit turun | Nilai token juga ditopang scanner dan alert, bukan hanya profit bot |
| Harga token stok bergerak | Kerugian inventaris | Batas eksposur per koin, rebalance rutin |
| Gagal bridge atau macet | Dana tertahan | Pantau lewat LayerZero Scan; batas ukuran untuk mode bridge |
| Gas Ethereum | Trade kecil tidak untung | Ethereum hanya dipakai untuk gap besar |
| Bug bot | Kerugian cepat | Paper trading dulu, circuit breaker harian, modal bertahap |
| Kunci wallet bocor | Modal hilang | Wallet terpisah, saldo minimal, treasury di multisig |
| Klaim berlebihan | Hilangnya kepercayaan | Semua angka di halaman statistik bisa dicek on-chain |
| Regulasi (reward holder dari profit) | Bisa dianggap produk investasi | Konsultasikan dengan ahli hukum sebelum Fase 5 |
| Mekanisme Pons belum dipetakan | Angka tokenomics tidak sesuai kenyataan | Pelajari dokumentasi Pons sebelum launch |
| Biaya konsolidasi profit ke Robinhood Chain | Porsi buyback dan reward berkurang | Konsolidasi mingguan; pilih rute bridge yang murah dan andal |
| $TRUE belum graduate dari bonding curve | Likuiditas $TRUE masih tipis | Buyback lewat curve ikut mendorong graduation |

---

## 10. Keputusan yang masih terbuka

- [ ] Ticker $TRUE masih tersedia di Pons?
- [ ] Handle X: @truecoin / @onetrueprice / @truechains?
- [ ] Pasangan quote $TRUE di Pons (ETH atau USDG)
- [ ] Mekanisme fee kreator dan aturan graduation di Pons
- [ ] Buyback: dibakar atau ditambahkan ke likuiditas (setelah aturan Pons dicek)
- [ ] Rute bridge untuk konsolidasi profit ke Robinhood Chain
- [ ] Besar modal awal bot dan sumbernya (dev buy, dana pribadi, atau keduanya)
- [ ] Ambang saldo untuk tingkat Basic dan Pro
- [ ] Formula final True Score
- [ ] Rasio pembagian profit final (35 / 25 / 40)

---

## Lampiran: referensi Pangea

| Hal | Detail |
|---|---|
| Dokumentasi | https://www.pangea.trade/app/docs |
| Dokumentasi untuk LLM | https://www.pangea.trade/llms-full.txt |
| Venue pool | Uniswap v4 (ETH/Base/Robinhood: ETH, BSC: BNB), Meteora DAMM v2 (Solana: SOL) |
| Desimal token | 9 di semua chain; bridge dibulatkan ke 6 desimal |
| Endpoint ID LayerZero | Ethereum 30101 · Base 30184 · Robinhood 30416 · BSC 30102 · Solana 30168 |
| Fee bridge | 0,2% + fee pesan LayerZero |
| Waktu bridge | 4–16 detik antar chain non-Ethereum; dari Ethereum ±30 detik atau lebih |
| Penanda token Pangea | Semua alamat berakhiran `6ea` |
| Launch token $TRUE | Pons V2, Robinhood Chain (bukan Pangea) |
| Referensi pembanding | ZGAP: https://zerogap.live |
