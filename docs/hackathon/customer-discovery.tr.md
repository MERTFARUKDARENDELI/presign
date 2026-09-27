# Müşteri görüşme kiti

Amaç satış değil **öğrenmek**: gerçekten ödeme yapılacak bir sorun olup olmadığını ve kimin karar verdiğini anlamak. Geçmişte ne yaptıklarını sorun. "Kullanır mısınız?" sorusu nazik ama değersiz cevaplar getirir.

## Kiminle (ilk 30 kişilik liste)

- **Protokol ekipleri (15):** güvenlik sorumlusu, CTO veya multisig imzacısı. Seçim: `docs/research` taramasında Squads multisig'i olan büyük programlar ve Solana'daki DeFi, LST ve perps ekipleri.
- **Auditor ve güvenlik araştırmacıları (5):** ileride hem kullanıcı hem satış kanalı olabilirler.
- **Hazine / fon operasyonları (5):** DAO hazineleri, market maker'lar.
- **AI agent geliştiricileri (5):** MCP ve gate tarafı için kontrol grubu.
- **Tanıştırma kanalları:** Superteam Türkiye, Colosseum Discord mentor saatleri, X'teki Solana güvenlik topluluğu.

## DM şablonları (İngilizce)

**Soğuk mesaj:**
> Hey [name] — I'm [you], building Presign, a pre-sign check for Squads multisig signers (after Drift). Not selling anything: I'm trying to learn how teams review proposals before approving. Would you have 15 minutes this week? Happy to share what we're seeing across teams — e.g. 98% of Squads multisigs on mainnet have no time lock.

**Değer önerisiyle (güvenlik ekiplerine):**
> Hi [name] — we built a tool that reads a Squads proposal the way an attacker hopes you won't: decodes the vault instructions, simulates them, and flags authority changes that leave the multisig. It flags the Drift approvals as critical from the signed bytes. Could I show you in 10 minutes and hear how your team reviews proposals today?

**Tanıştırma isteği:**
> Hi [name] — we're a team in the Colosseum hackathon working on pre-sign verification for Solana multisigs. Do you know 1–2 people who sign for a protocol multisig and might share how their review works? 15 min, purely learning.

## Görüşme soruları (15 dakika)

1. Ekibinizin onayladığı son multisig proposal'ını anlatır mısın? Kim oluşturdu, nasıl kontrol ettiniz, hangi araçları kullandınız?
2. Bir proposal'ın gerçekte ne yaptığını nasıl doğruluyorsunuz? Squads arayüzü mü, explorer mı, CLI mı, Ledger hash'i mi?
3. Tam anlamadığın bir şeyi hiç imzaladın mı? Kıl payı kurtulduğunuz bir durum oldu mu?
4. Drift'ten sonra bir şey değiştirdiniz mi (time lock, threshold, nonce politikası, imza süreci)? Kim karar verdi, ne kadar sürdü?
5. Ayda kaç proposal geliyor? Kaç imzacı var, hepsi teknik mi, hangi saat dilimlerinde?
6. Güvenlik için bugün neye para veya zaman harcıyorsunuz (audit, monitoring, iç review)?
7. Böyle bir aracı ekibe kim getirir? Bütçe kimde?
8. **Kapanış:** "Multisig'inizi Watchtower'a bu hafta read-only bağlasak dener misiniz? Konuşmam gereken 1–2 kişi var mı?"

## Sinyali nasıl okursunuz

| Güçlü ✅ | Zayıf ⚠️ |
|---|---|
| Drift sonrası süreçlerini değiştirmişler | "İlginç", "güzel fikir" |
| Bu iş için zaten zaman veya para harcıyorlar | "Hazır olunca link at" deyip taahhüt vermemeleri |
| Pilot için tarih veriyorlar ya da multisig adresi paylaşıyorlar | Yalnızca varsayımsal konuşmaları |
| Başka birine yönlendiriyorlar | "Squads'ın araçları yetiyor" |

## Takip tablosu

| Tarih | Kişi | Rol / ekip | Kanal | Mevcut süreç | Acı (1–5) | Sinyal | Sonraki adım |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

**Karar noktası (4 Ekim):** Protokol görüşmelerinin en az 3'ünde güçlü sinyal varsa odak multisig ekipleri olarak kalır. Agent geliştiricileri daha güçlü sinyal verirse pitch'te API/MCP öne çıkarılır. Ürün iki senaryoyu da destekliyor.
