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
