# Presign — Colosseum planı (ekip içi)

Son teslim: **12 Ekim 2026, 23:59 PT = 13 Ekim 09:59 Türkiye saati.** Son güne bırakmayın; hedef **11 Ekim akşamı** teslim. Güncelleme: 2 Ekim.

## Hazır olanlar (kod tarafı)

- **Görmek:** Squads v4 çözücü (36 talimat, 7 hesap türü, batch ve buffer dahil), Anchor IDL çözücü, BPF loader; kasa simülasyonu (lookup table kullanan teklifler dahil); `/verify`, `/transaction`, `/case/drift`. Teklif geçmişinden "önceden imzalanmış oy" tespiti: Drift #7'de iki oy da durable nonce ile gelmiş, nonce hesapları 8 ve 1 gün boşta beklemiş; iki hesabı da konsey dışı tek bir adres açmış (`docs/research/drift-nonce-trail.md`).
- **Durdurmak:** Presign Guard on-chain programı (Anchor 1.x). 11 program testi geçiyor. Gerçek Squads programıyla yerel validator'da uçtan uca çalıştı: zamanlama → uyarı → veto → yürütme reddi. **Devnet'te canlı** (2 Ekim): program `A8cpj1d7zxF3T9kZzVn2wkEueGxqGVgd9VaqBA54EDRS`; gerçek Squads multisig ile ele geçirme zamanlandı, Presign CRITICAL dedi, bağımsız guardian veto etti, program yürütmeyi reddetti.
- **Kural koymak:** ekip politikası motoru (11 kural; `/verify`, API, Watchtower, MCP) ve 111 kurallık herkese açık katalog (`/rules`).
- Watchtower Telegram botu (`/watch`, `/check`), MCP sunucusu, API'de deterministik `gate`, program upgrade'lerinde verified-build kontrolü.
- Mainnet doğrulamaları: Drift saldırısı (CRITICAL), census (157.117 multisig), gerçek batch ve buffer teklifleri, 20 aktif multisig ve 15 gerçek işlemle duman testi (hatasız).
- 719 uygulama testi + 11 program testi, CI, Apache-2.0, README, başvuru metni, video senaryoları, pitch deck.

## Sadece sizin yapabileceğiniz işler (öncelik sırasıyla)

"Durum" sütununu siz doldurun; bana da yazın ki planı ona göre güncelleyeyim.

| # | İş | Ne zaman | Durum | Not |
|---|---|---|---|---|
| 1 | İki ekip üyesi de colosseum.com'da kayıtlı, takım kurulmuş | Hemen |  | Kayıt olmayan üye diskalifiye olabilir |
| 2 | GitHub'da **public** repo | Hemen | ✅ 2 Eki | https://github.com/MERTFARUKDARENDELI/presign — tüm commit geçmişi push edildi, CI GitHub Actions'ta çalışıyor |
| 3 | **Devnet SOL** | — | ✅ 2 Eki | 15 SOL geldi; Guard devnet'e deploy edildi ve demo uçtan uca çalıştı (aşağıya bakın) |
| 4 | Deploy (Vercel önerilir) | 3–4 Ekim |  | Env: `HELIUS_API_KEY`, `SOLANA_CLUSTER=mainnet-beta`, `NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta`; `NEXT_PUBLIC_GUARD_PROGRAM_ID` mainnet'te boş kalsın |
| 5 | **Anthropic API anahtarı** (isteğe bağlı) | Uygun olduğunda |  | AI katmanı Claude Sonnet 5.5'e geçti. Anahtar yok; AI açıklamaları kapalı, kesin analiz etkilenmiyor. `ANTHROPIC_API_KEY`'i `.env.local`'e ve Vercel'e siz ekleyin |
| 6 | Telegram botu: @BotFather → `/newbot` → token | 4 Ekim |  | Token'ı bana yazmayın; `.env.local`'e siz ekleyin. Sonra `npm run watchtower -- --once` ile canlı test ederiz |
| 7 | Müşteri görüşmeleri: 10+ görüşme, 3 design partner | 2–7 Ekim |  | Kit: `customer-discovery.tr.md`. Başvurunun en zayıf kısmı burası |
| 8 | Ekip bilgileri: rol, arka plan, "neden biz" | 5 Ekim |  | İsimler ve takım adı (Nonce Sense) başvuru metnine, deck'e ve pitch senaryosuna yazıldı; rol ve arka plan sizden |
| 9 | Pitch ve demo videoları | 9–10 Ekim |  | Senaryolar: `pitch-video.md`, `demo-video.md`; devnet sahnesi: `devnet-demo.md` |
| 10 | Başvuruyu gönderin | 11 Ekim |  | Metin: `submission.md` (köşeli parantezli yerleri doldurun) |

## Günlük takvim

| Tarih | Ürün (benimle) | İş tarafı (siz) |
|---|---|---|
| 2–4 Eki | Devnet deploy + demo (SOL gelince), deploy desteği, canlı ortamda doğrulama | Kayıt, repo, VPN + faucet, deploy, bot |
| 5–7 Eki | Görüşmelerden çıkan ihtiyaçlar; design partner multisig'lerini Watchtower'a bağlama | Görüşmeler, design partner pilotları |
| 8 Eki | Son düzeltmeler; başvuru metni, deck ve README'de son rakamlar | Ekip bilgileri, talep verileri |
| 9–10 Eki | Video ortamı (mainnet sahneleri + devnet Guard sahnesi) | Video çekimi ve düzenleme |
| 11 Eki | Son kontrol | **Teslim** |

## Talep doğrulama hedefleri (başvuruda yazılacak)

- 10+ görüşme (protokol güvenlik sorumluları, multisig imzacıları, auditor'lar)
- 3+ design partner (Watchtower'ı kendi multisig'ine bağlayan ya da politikasını yazan ekip)
- Verifier kullanımı: kaç imzacı, kaç teklif kontrol edildi
- Varsa LOI veya "ücretli olursa kullanırız" yazılı ifadesi

## Sorumlu ifşa kuralı

Taramada adı geçen programların yapılandırma ayrıntıları `scripts/research/output/` altında, git'e girmeyen bir dosyada duruyor. Bunları **kamuya açık paylaşmayın**. Zayıf yapılandırmalı bir ekiple iletişime geçmek isterseniz özelden, yardım teklifiyle yazın. Bu aynı zamanda en iyi satış görüşmesidir. Aynı kural duman testlerinde incelenen multisig'ler için de geçerli.
