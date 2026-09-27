# Presign — Colosseum planı (ekip içi)

Son teslim: **12 Ekim 2026, 23:59 PT = 13 Ekim 09:59 Türkiye saati.** Son güne bırakmayın; hedef 11 Ekim akşamı teslim.

## Hazır olanlar (kod tarafı)

- Squads v4 çözücü, Anchor IDL çözücü, BPF loader çözücü
- Multisig analiz katmanı, deterministik kurallar ve vault simülasyonu
- `/verify` (proposal ve multisig inceleme), `/transaction`, `/case/drift` (gerçek saldırının yeniden oynatılması), `/docs`
- Watchtower (Telegram, Slack/Discord, konsol), MCP sunucusu, API'de `gate`
- Mainnet taraması: 157.117 multisig, %98,2'sinde time lock yok, 13 büyük programdan 8'inde time lock yok
- 362 test, typecheck, lint ve build temiz; Apache-2.0 lisansı; README; başvuru metni; video senaryoları

## Sadece sizin yapabileceğiniz işler (öncelik sırasıyla)

| # | İş | Ne zaman | Not |
|---|---|---|---|
| 1 | İki ekip üyesi de colosseum.com'da kayıt olsun, takımı kurun | **Bugün** | Kayıt olmayan üye diskalifiye olabilir |
| 2 | GitHub'da **public** repo açın | Bugün/yarın | Repo URL'sini verirseniz commit geçmişiyle birlikte push'u ben yapabilirim (makinede `gh auth` gerekir) |
| 3 | Deploy (Vercel önerilir) | 29 Eylül | Env: `HELIUS_API_KEY`, `SOLANA_CLUSTER=mainnet-beta`, `NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta` (OpenAI isteğe bağlı). Hesap açmak ve anahtar girmek size ait |
| 4 | Telegram botu: @BotFather → `/newbot` → token; botu bir gruba ekleyin, chat ID'yi alın | 29 Eylül | Token'ı bana yazmayın; `.env.local`'e siz ekleyin. Sonra `npm run watchtower -- --once` ile test ederiz |
| 5 | Müşteri görüşmeleri: en az 10 görüşme, 3 design partner | 28 Eylül – 5 Ekim | Kit: `customer-discovery.tr.md` |
| 6 | X hesabı açıp "build in public" paylaşımları | 28 Eylül'den itibaren her gün | Taslaklar: `x-posts.md` |
| 7 | Ekip bilgileri: isim, rol, arka plan, "neden biz" cümlesi | 1 Ekim | Başvuru metni ve pitch bu bilgiyle tamamlanacak |
| 8 | Pitch ve demo videolarını çekin | 9–10 Ekim | Senaryolar: `pitch-video.md`, `demo-video.md` |
| 9 | Başvuruyu gönderin | 11 Ekim | Metin: `submission.md` |

## Günlük takvim

| Tarih | Ürün (benimle) | İş tarafı (siz) |
|---|---|---|
| 28–29 Eyl | Deploy desteği, canlı ortamda doğrulama | Kayıt, repo, deploy, bot; 30 DM gönderin |
| 30 Eyl – 3 Eki | Görüşmelerden çıkan ihtiyaçlar (ör. politika kuralları, Slack entegrasyonu); gerçek batch/buffer örnekleriyle doğrulama | Görüşmeler; X'te Drift replay paylaşımı |
| 4–6 Eki | Design partner'ların multisig'lerini Watchtower'a bağlama | Design partner'larla pilot; census paylaşımı |
| 7–8 Eki | Son düzeltmeler, performans, mobil kontrol | Başvuru metnindeki boşlukları doldurun |
| 9–10 Eki | Video için ortam hazırlığı | Video çekimi ve düzenleme |
| 11 Eki | Son kontrol | **Teslim** |

## Talep doğrulama hedefleri (başvuruda yazılacak)

- 10+ görüşme (protokol güvenlik sorumluları, multisig imzacıları, auditor'lar)
- 3+ design partner (Watchtower'ı kendi multisig'ine bağlayan ekip)
- Verifier kullanımı: kaç imzacı, kaç proposal kontrol edildi
- Varsa LOI veya "ücretli olursa kullanırız" yazılı ifadesi

## Sorumlu ifşa kuralı

Taramada adı geçen programların yapılandırma ayrıntıları `scripts/research/output/` altında, git'e girmeyen bir dosyada duruyor. Bunları **kamuya açık paylaşmayın**. Zayıf yapılandırmalı bir ekiple iletişime geçmek isterseniz özelden, yardım teklifiyle yazın. Bu aynı zamanda en iyi satış görüşmesidir.
