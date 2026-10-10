// Supabase paneli > Project Settings > API bölümünden alınır.
// "anon / publishable" anahtar herkese açık olabilir; "service_role" anahtarını ASLA buraya yazma.
export const SUPABASE_URL = 'https://nywadrlerzyzvcdbgepe.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_PSzXUlGJb3WEbv07JWhNRw_Igv7COdi';

// Bir sesli kanalda aynı anda bulunabilecek en fazla kişi.
export const MAX_VOICE = 10;

// Sesli bağlantı için sunucular. STUN çoğu ev ağında yeterlidir.
// Bazı ağlarda (mobil veri, okul/iş ağı) ses bağlanmazsa buraya bir TURN sunucusu eklenmeli.
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];
