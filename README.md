# Muhabbet

Arkadaş grubu için yazılı ve sesli sohbet sitesi. Derleme adımı yok: düz HTML/CSS/JS.

- **Yazı kanalları:** anlık mesajlaşma, mesaj geçmişi, okunmamış işareti.
- **Ses kanalları:** kanal başına en fazla 10 kişi, mikrofon/ses kapatma, konuşan kişi göstergesi.
- **Giriş:** e-posta + şifre. Sunucuya yalnızca davet kodunu bilenler katılabilir.

Arka uç Supabase'tir (hesap, veritabanı, anlık iletişim). Ses doğrudan tarayıcılar arasında akar (WebRTC), Supabase yalnızca bağlantının kurulmasına aracılık eder.

## Kurulum

1. <https://supabase.com> üzerinde ücretsiz bir proje aç.
2. `supabase/schema.sql` dosyasını aç, **en alttaki davet kodunu değiştir**, tamamını SQL Editor'e yapıştırıp çalıştır.
3. Authentication > Sign In / Providers > Email bölümünde **Confirm email** seçeneğini kapat (açık kalırsa herkes kayıt sonrası e-postasını onaylamak zorunda kalır; ücretsiz katmanda saatlik e-posta sınırı düşüktür).
4. Project Settings > API bölümünden **Project URL** ve **anon / publishable** anahtarı `config.js` dosyasına yaz.

## Çalıştırma

Mikrofon yalnızca `localhost` veya HTTPS üzerinde çalışır; dosyayı çift tıklayıp açmak yetmez.

```
npx serve .
```

Yayınlamak için klasörü GitHub Pages gibi herhangi bir statik barındırmaya koymak yeterli.

## Davet kodunu değiştirmek

SQL Editor'de:

```sql
update public.server_settings set invite_code = 'yeni-kod';
```

Mevcut üyeler etkilenmez. Birini çıkarmak için Authentication > Users bölümünden kullanıcıyı sil.

## Bilinen sınırlar

- TURN sunucusu tanımlı değil. Çoğu ev ağında ses sorunsuz bağlanır; mobil veri ya da kısıtlı okul/iş ağlarında bağlanmayabilir. Çözüm: `config.js` içindeki `ICE_SERVERS` listesine bir TURN sunucusu eklemek.
- Ses kanalında herkes herkese doğrudan bağlanır. 10 kişide her katılımcı 9 ses akışı gönderir; bu ses için sorun değil ama görüntü/ekran paylaşımı eklenecekse aracı bir medya sunucusu (ör. LiveKit) gerekir.
