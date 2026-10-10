import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, MAX_VOICE, ICE_SERVERS } from './config.js';

const PAGE = 50;
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function show(view) {
  for (const v of ['setup', 'auth', 'join', 'app']) $(v).hidden = v !== view;
}

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 4000);
}

// ---------- Durum ----------

let sb;
let me = null; // { id, username }
let started = false;
let routedUser; // route() en son hangi kullanıcı için çalıştı
const sessionId = crypto.randomUUID(); // sekme başına; aynı hesap iki cihazda açılabilir

const profiles = new Map(); // user id -> kullanıcı adı
let channels = [];
let activeId = null;
const unread = new Set();
const seen = new Set(); // ekrandaki mesaj id'leri
let oldestId = null;

let lobby = null; // çevrimiçi listesi + ses sinyalleşmesi
let dbChanges = null;

// mic: ham mikrofon; stream: gürültü kapısından geçmiş, karşıya giden ses
// share: paylaşılan ekranın görüntü parçası (yayın yoksa null)
const voice = { channelId: null, mic: null, stream: null, gate: null, share: null, muted: false, deafened: false };
const peers = new Map(); // karşı sessionId -> { pc, audio, pending, created, video, screen }
const tiles = new Map(); // yayın yapanın sessionId'si -> { node, key }
const watching = new Set(); // izlemek istediğim yayıncıların sessionId'leri; herkes görsün diye durumuma yazılır

// Ekran yayını her izleyiciye ayrı ayrı gönderilir; toplam yükleme hızı bu sınırı aşmasın.
const SHARE_PEER_BITRATE = 2_500_000;
const SHARE_TOTAL_BITRATE = 6_000_000;
const meters = new Map(); // sessionId -> { source, analyser, buf }
let audioCtx = null;

// Kişi başına ses düzeyi (0–1). Yalnızca bu tarayıcıda saklanır; herkes kendi duyduğunu ayarlar.
let volumes = {};
try {
  volumes = JSON.parse(localStorage.getItem('volumes')) ?? {};
} catch {}

// Giriş duyarlılığı eşiği (dB). En soldaki değer kapıyı kapatır, her ses geçer.
const GATE_MIN = -70;
const GATE_MAX = -10;
let gateDb = -50;
try {
  const saved = Number(localStorage.getItem('gate') ?? gateDb);
  if (saved >= GATE_MIN && saved <= GATE_MAX) gateDb = saved;
} catch {}
let gateModule = null;

// ---------- Giriş ----------

function authError(error) {
  if (error.message === 'Invalid login credentials') return 'E-posta veya şifre yanlış.';
  if (error.message === 'Email not confirmed') return 'Önce e-postana gelen onay bağlantısına tıkla.';
  if (error.message === 'User already registered') return 'Bu e-posta zaten kayıtlı, giriş yap.';
  return error.message;
}

function setMsg(id, text, ok = false) {
  $(id).textContent = text;
  $(id).classList.toggle('ok', ok);
}

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setMsg('authMsg', '');
  const { error } = await sb.auth.signInWithPassword({
    email: $('email').value.trim(),
    password: $('password').value,
  });
  if (error) setMsg('authMsg', authError(error));
});

$('signupBtn').addEventListener('click', async () => {
  if (!$('authForm').reportValidity()) return;
  setMsg('authMsg', '');
  const { data, error } = await sb.auth.signUp({
    email: $('email').value.trim(),
    password: $('password').value,
  });
  if (error) setMsg('authMsg', authError(error));
  else if (!data.session) setMsg('authMsg', 'Kayıt tamam. E-postana gelen onay bağlantısına tıkla, sonra giriş yap.', true);
});

$('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setMsg('joinMsg', '');
  const { error } = await sb.rpc('join_server', {
    code: $('invite').value.trim(),
    uname: $('username').value.trim(),
  });
  if (error) {
    if (error.code === '23505') setMsg('joinMsg', 'Bu kullanıcı adı alınmış.');
    else if (error.code === '23514') setMsg('joinMsg', 'Kullanıcı adı 2–24 karakter olmalı.');
    else setMsg('joinMsg', error.message);
    return;
  }
  const { data } = await sb.auth.getSession();
  routedUser = undefined;
  route(data.session);
});

for (const btn of document.querySelectorAll('.logout')) {
  btn.addEventListener('click', () => sb.auth.signOut());
}

async function route(session) {
  const uid = session?.user.id ?? null;
  if (uid === routedUser) return;
  routedUser = uid;

  if (!uid) {
    await stopApp();
    show('auth');
    return;
  }
  const { data: profile, error } = await sb
    .from('profiles').select('id, username').eq('id', uid).maybeSingle();
  if (routedUser !== uid) return;
  if (error) {
    routedUser = undefined;
    show('auth');
    setMsg('authMsg', 'Sunucuya ulaşılamadı: ' + error.message);
    return;
  }
  if (!profile) {
    show('join');
    return;
  }
  me = profile;
  await startApp();
}

// ---------- Uygulama ----------

async function startApp() {
  if (started) return;
  started = true;
  $('meName').textContent = me.username;
  show('app');

  const { data } = await sb.from('profiles').select('id, username');
  for (const p of data ?? []) profiles.set(p.id, p.username);

  await loadChannels();
  const first = channels.find((c) => c.kind === 'text');
  if (first) selectChannel(first.id);

  dbChanges = sb.channel('db-changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => onMessage(p.new))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'channels' }, loadChannels)
    .subscribe();

  await sb.realtime.setAuth();
  lobby = sb.channel('lobby', { config: { private: true, presence: { key: sessionId } } })
    .on('presence', { event: 'sync' }, onPresence)
    .on('broadcast', { event: 'signal' }, ({ payload }) => onSignal(payload))
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') trackMe();
      else if (status === 'CHANNEL_ERROR') console.error('lobby', err);
    });
}

async function stopApp() {
  if (!started) return;
  leaveVoice();
  await sb.removeAllChannels();
  lobby = dbChanges = null;
  started = false;
  me = null;
  channels = [];
  activeId = null;
  profiles.clear();
  unread.clear();
  $('messageList').replaceChildren();
}

// ---------- Kanallar ----------

async function loadChannels() {
  const { data, error } = await sb.from('channels').select('*').order('id');
  if (error) return toast('Kanallar yüklenemedi: ' + error.message);
  channels = data;
  if (voice.channelId && !channels.some((c) => c.id === voice.channelId)) leaveVoice();
  renderChannels();
}

function presences() {
  if (!lobby) return [];
  return Object.entries(lobby.presenceState()).map(([sid, metas]) => ({ sid, ...metas[metas.length - 1] }));
}

function avatar(userId, name) {
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const node = el('span', { className: 'avatar' }, (name[0] ?? '?').toUpperCase());
  node.style.background = `hsl(${hash % 360} 45% 45%)`;
  return node;
}

function renderChannels() {
  const present = presences();

  $('textChannels').replaceChildren(...channels.filter((c) => c.kind === 'text').map((c) => {
    const btn = el('button', { className: 'channel' }, '# ' + c.name);
    btn.classList.toggle('active', c.id === activeId);
    btn.classList.toggle('unread', unread.has(c.id));
    btn.addEventListener('click', () => selectChannel(c.id));
    return el('li', {}, btn);
  }));

  $('voiceChannels').replaceChildren(...channels.filter((c) => c.kind === 'voice').map((c) => {
    const btn = el('button', { className: 'channel' }, '🔊 ' + c.name);
    btn.classList.toggle('active', c.id === voice.channelId);
    btn.addEventListener('click', () => joinVoice(c.id));
    const occupants = present.filter((p) => p.voice === c.id).map((p) => {
      const row = el('li', { className: 'person' }, avatar(p.user_id, p.username), el('span', { className: 'name' }, p.username));
      row.dataset.sid = p.sid;
      if (p.sharing) row.append(el('span', { className: 'tag live' }, 'yayında'));
      if (p.deafened) row.append(el('span', { className: 'tag' }, 'sağır'));
      else if (p.muted) row.append(el('span', { className: 'tag' }, 'sessiz'));
      if (c.id === voice.channelId && p.user_id !== me.id) row.append(volumeSlider(p));
      return row;
    });
    return el('li', {}, btn, el('ul', { className: 'occupants' }, ...occupants));
  }));

  const online = new Map();
  for (const p of present) online.set(p.user_id, p.username);
  $('memberList').replaceChildren(...[...online].sort((a, b) => a[1].localeCompare(b[1], 'tr')).map(
    ([id, name]) => el('li', { className: 'person' }, avatar(id, name), el('span', { className: 'name' }, name)),
  ));

  const current = channels.find((c) => c.id === voice.channelId);
  $('voicePanel').hidden = !current;
  if (current) $('voiceName').textContent = current.name;
  $('muteBtn').textContent = voice.muted ? 'Mikrofon kapalı' : 'Mikrofon açık';
  $('muteBtn').setAttribute('aria-pressed', voice.muted);
  $('deafenBtn').textContent = voice.deafened ? 'Ses kapalı' : 'Ses açık';
  $('deafenBtn').setAttribute('aria-pressed', voice.deafened);
  $('shareBtn').textContent = voice.share ? `Yayını durdur (${viewers().size} izleyici)` : 'Ekran paylaş';
  $('shareBtn').setAttribute('aria-pressed', !!voice.share);
  renderStage();
}

for (const btn of document.querySelectorAll('.add')) {
  btn.addEventListener('click', () => {
    $('channelForm').dataset.kind = btn.dataset.kind;
    $('channelDialogTitle').textContent = btn.dataset.kind === 'text' ? 'Yazı kanalı ekle' : 'Ses kanalı ekle';
    $('channelName').value = '';
    setMsg('channelMsg', '');
    $('channelDialog').showModal();
  });
}
$('channelCancel').addEventListener('click', () => $('channelDialog').close());
$('channelForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = $('channelForm').dataset.kind;
  const name = $('channelName').value.trim();
  if (!name) return;
  const { data, error } = await sb.from('channels').insert({ name, kind }).select().single();
  if (error) return setMsg('channelMsg', error.message);
  $('channelDialog').close();
  await loadChannels();
  if (kind === 'text') selectChannel(data.id);
});

$('menuBtn').addEventListener('click', () => $('app').classList.toggle('menu-open'));
$('app').addEventListener('click', (e) => {
  if (!e.target.closest('#sidebar, #menuBtn')) $('app').classList.remove('menu-open');
});

// ---------- Mesajlar ----------

function formatTime(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return d.toLocaleDateString('tr-TR') + ' ' + time;
}

function messageNode(m) {
  return el('li', { className: 'message' },
    el('div', { className: 'head' },
      el('span', { className: 'author' }, profiles.get(m.user_id) ?? 'bilinmeyen'),
      el('time', { dateTime: m.created_at }, formatTime(m.created_at))),
    el('div', { className: 'body' }, m.content));
}

async function fetchMessages(channelId, beforeId) {
  let query = sb.from('messages').select('*').eq('channel_id', channelId).order('id', { ascending: false }).limit(PAGE);
  if (beforeId) query = query.lt('id', beforeId);
  const { data, error } = await query;
  if (error) {
    toast('Mesajlar yüklenemedi: ' + error.message);
    return [];
  }
  return data.reverse();
}

async function selectChannel(id) {
  activeId = id;
  unread.delete(id);
  seen.clear();
  oldestId = null;
  $('app').classList.remove('menu-open');
  $('channelTitle').textContent = '# ' + (channels.find((c) => c.id === id)?.name ?? '');
  $('messageList').replaceChildren();
  $('olderBtn').hidden = true;
  renderChannels();

  const rows = await fetchMessages(id);
  if (activeId !== id) return;
  // Yükleme sırasında anlık gelen mesajlar listede olabilir; eskileri başa ekle.
  const fresh = rows.filter((m) => !seen.has(m.id));
  for (const m of fresh) seen.add(m.id);
  $('messageList').prepend(...fresh.map(messageNode));
  if (!seen.size) $('messageList').append(el('li', { className: 'empty' }, 'Henüz mesaj yok. İlk mesajı sen yaz.'));
  oldestId = rows[0]?.id ?? null;
  $('olderBtn').hidden = rows.length < PAGE;
  $('messages').scrollTop = $('messages').scrollHeight;
  $('input').focus();
}

$('olderBtn').addEventListener('click', async () => {
  const id = activeId;
  const box = $('messages');
  const before = box.scrollHeight;
  const rows = await fetchMessages(id, oldestId);
  if (activeId !== id) return;
  const fresh = rows.filter((m) => !seen.has(m.id));
  for (const m of fresh) seen.add(m.id);
  $('messageList').prepend(...fresh.map(messageNode));
  if (rows.length) oldestId = rows[0].id;
  $('olderBtn').hidden = rows.length < PAGE;
  box.scrollTop += box.scrollHeight - before;
});

async function onMessage(m) {
  if (m.channel_id !== activeId) {
    unread.add(m.channel_id);
    renderChannels();
    return;
  }
  if (seen.has(m.id)) return;
  seen.add(m.id);
  if (!profiles.has(m.user_id)) {
    const { data } = await sb.from('profiles').select('username').eq('id', m.user_id).maybeSingle();
    if (data) profiles.set(m.user_id, data.username);
    if (m.channel_id !== activeId) return;
  }
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  $('messageList').querySelector('.empty')?.remove();
  $('messageList').append(messageNode(m));
  if (atBottom || m.user_id === me.id) box.scrollTop = box.scrollHeight;
}

async function sendMessage() {
  const content = $('input').value.trim();
  if (!content || !activeId) return;
  $('input').value = '';
  resizeInput();
  const { data, error } = await sb.from('messages').insert({ channel_id: activeId, content }).select().single();
  if (error) {
    $('input').value = content;
    resizeInput();
    return toast('Mesaj gönderilemedi: ' + error.message);
  }
  onMessage(data);
}

function resizeInput() {
  $('input').style.height = 'auto';
  $('input').style.height = $('input').scrollHeight + 2 + 'px';
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});
$('input').addEventListener('input', resizeInput);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

// ---------- Çevrimiçi durumu ----------

function trackMe() {
  return lobby?.track({
    user_id: me.id,
    username: me.username,
    voice: voice.channelId,
    muted: voice.muted,
    deafened: voice.deafened,
    sharing: !!voice.share,
    watching: [...watching],
  });
}

function onPresence() {
  for (const p of presences()) profiles.set(p.user_id, p.username);
  renderChannels();
  reconcilePeers();
  applyVolumes();
  syncShare();
}

function applyVolumes() {
  for (const p of presences()) {
    const peer = peers.get(p.sid);
    if (peer) peer.audio.volume = volumes[p.user_id] ?? 1;
  }
}

function volumeSlider(p) {
  const percent = Math.round((volumes[p.user_id] ?? 1) * 100);
  const slider = el('input', { type: 'range', min: 0, max: 100, value: percent, title: `Ses: %${percent}` });
  slider.setAttribute('aria-label', `${p.username} ses düzeyi`);
  slider.addEventListener('input', () => {
    volumes[p.user_id] = slider.value / 100;
    slider.title = `Ses: %${slider.value}`;
    applyVolumes();
    try {
      localStorage.setItem('volumes', JSON.stringify(volumes));
    } catch {}
  });
  return slider;
}

// ---------- Sesli sohbet (WebRTC, herkes herkese doğrudan bağlanır) ----------

async function joinVoice(id) {
  if (voice.channelId === id) return;
  if (!navigator.mediaDevices?.getUserMedia) return toast('Bu tarayıcıda mikrofon kullanılamıyor (site HTTPS üzerinden açılmalı).');
  if (presences().filter((p) => p.voice === id).length >= MAX_VOICE) return toast(`Bu kanal dolu (en fazla ${MAX_VOICE} kişi).`);
  if (voice.channelId) leaveVoice();

  let mic;
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    return toast('Mikrofona erişilemedi. Tarayıcıdan mikrofon izni ver.');
  }
  const gate = await openGate(mic);
  if (voice.channelId) leaveVoice(); // izin beklenirken başka kanala tıklandıysa
  voice.channelId = id;
  voice.mic = mic;
  voice.gate = gate;
  voice.stream = gate.stream;
  applyGate();
  addMeter(sessionId, voice.stream);
  syncDesktopKey();
  await trackMe();
  renderChannels();
  reconcilePeers();
}

// Mikrofonu gürültü kapısından geçirir: eşiğin altındaki sesler (fare, klavye, fan) karşıya gitmez.
// Kapı kurulamazsa ham mikrofon gönderilir.
async function openGate(mic) {
  try {
    audioCtx ??= new AudioContext();
    audioCtx.resume();
    await (gateModule ??= audioCtx.audioWorklet.addModule('gate-worklet.js'));
    const source = audioCtx.createMediaStreamSource(mic);
    const node = new AudioWorkletNode(audioCtx, 'gate', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(node).connect(dest);
    node.port.onmessage = (e) => showLevel(e.data);
    return { stream: dest.stream, source, node };
  } catch (err) {
    console.error('gate', err);
    return { stream: mic };
  }
}

function applyGate() {
  const off = gateDb <= GATE_MIN;
  $('gateSlider').value = gateDb;
  $('gateValue').textContent = off ? 'kapalı' : `${gateDb} dB`;
  voice.gate?.node?.parameters.get('threshold').setValueAtTime(off ? 0 : 10 ** (gateDb / 20), audioCtx.currentTime);
}

function showLevel({ level, open }) {
  const db = 20 * Math.log10(level || 1e-6);
  const percent = ((db - GATE_MIN) / (GATE_MAX - GATE_MIN)) * 100;
  $('micLevel').style.width = `${Math.min(100, Math.max(0, percent))}%`;
  $('micLevel').classList.toggle('open', open);
}

$('gateSlider').addEventListener('input', () => {
  gateDb = Number($('gateSlider').value);
  applyGate();
  try {
    localStorage.setItem('gate', gateDb);
  } catch {}
});
applyGate();

function leaveVoice() {
  if (!voice.channelId) return;
  for (const sid of [...peers.keys()]) closePeer(sid);
  voice.share?.stop();
  voice.share = null;
  watching.clear();
  voice.mic.getTracks().forEach((t) => t.stop());
  voice.stream.getTracks().forEach((t) => t.stop());
  voice.gate.source?.disconnect();
  voice.gate.node?.disconnect();
  removeMeter(sessionId);
  voice.channelId = voice.mic = voice.stream = voice.gate = null;
  voice.muted = voice.deafened = false;
  syncDesktopKey();
  trackMe();
  renderChannels();
}

function setMuted(muted) {
  voice.muted = muted;
  voice.stream.getAudioTracks().forEach((t) => (t.enabled = !muted));
}

$('leaveBtn').addEventListener('click', leaveVoice);
function toggleMute() {
  if (voice.deafened) return; // ses kapalıyken mikrofon da kapalı kalır
  setMuted(!voice.muted);
  trackMe();
  renderChannels();
}
$('muteBtn').addEventListener('click', toggleMute);

// Susturma tuşu. Yalnızca bu sekme odaktayken çalışır: tarayıcı, başka penceredeyken basılan tuşları sayfaya bildirmez.
let muteKey = null; // { code, ctrl, alt, shift }
try {
  muteKey = JSON.parse(localStorage.getItem('muteKey'));
} catch {}
let capturingKey = false;

function keyLabel({ code, ctrl, alt, shift }) {
  const name = code.replace(/^(Key|Digit)/, '').replace(/^Numpad/, 'Num ');
  return (ctrl ? 'Ctrl+' : '') + (alt ? 'Alt+' : '') + (shift ? 'Shift+' : '') + name;
}

function renderMuteKey() {
  $('muteKeyBtn').textContent = capturingKey ? 'Bir tuşa bas…' : muteKey?.code ? keyLabel(muteKey) : 'Yok';
  $('muteKeyBtn').setAttribute('aria-pressed', capturingKey);
}

// Masaüstü uygulamasında (desktop/) tuş Windows'a genel kısayol olarak kaydedilir ve başka uygulama öndeyken de çalışır.
// Kayıtlı tuşu Windows yuttuğu için yalnızca ses kanalındayken kayıtlı tutulur.
const desktop = window.muhabbetDesktop;
let globalKey = false; // tuş şu an genel kısayol olarak kayıtlı mı
desktop?.onToggleMute(() => voice.channelId && toggleMute());

async function syncDesktopKey() {
  if (!desktop) return;
  const key = voice.channelId && !capturingKey && muteKey?.code ? muteKey : null;
  globalKey = false;
  const ok = await desktop.setMuteKey(key);
  globalKey = !!key && ok;
  if (key && !ok) toast('Bu tuş genel kısayol olarak atanamadı; yalnızca Muhabbet penceresi öndeyken çalışır.');
}

$('muteKeyBtn').addEventListener('click', () => {
  capturingKey = !capturingKey;
  $('muteKeyBtn').blur(); // basılan tuş düğmeyi yeniden tetiklemesin
  renderMuteKey();
  syncDesktopKey(); // atama sırasında eski tuş yutulmasın
});

document.addEventListener('keydown', (e) => {
  if (capturingKey) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return; // birleşimin asıl tuşunu bekle
    e.preventDefault();
    e.stopPropagation();
    capturingKey = false;
    if (e.code !== 'Escape') {
      muteKey = ['Backspace', 'Delete'].includes(e.code) ? null : { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
      try {
        localStorage.setItem('muteKey', JSON.stringify(muteKey));
      } catch {}
    }
    syncDesktopKey();
    return renderMuteKey();
  }
  if (!muteKey?.code || !voice.channelId || e.repeat || globalKey) return;
  if (e.code !== muteKey.code || e.ctrlKey !== muteKey.ctrl || e.altKey !== muteKey.alt || e.shiftKey !== muteKey.shift) return;
  // Mesaj yazarken düz harf tuşu susturmasın; Ctrl/Alt birleşimleri ve F tuşları her yerde çalışır.
  const typing = e.target.matches?.('input:not([type="range"]), textarea');
  if (typing && !muteKey.ctrl && !muteKey.alt && !/^F\d+$/.test(muteKey.code)) return;
  e.preventDefault();
  toggleMute();
}, true);
renderMuteKey();
$('deafenBtn').addEventListener('click', () => {
  voice.deafened = !voice.deafened;
  setMuted(voice.deafened);
  for (const { audio } of peers.values()) audio.muted = voice.deafened;
  trackMe();
  renderChannels();
});

// ---------- Ekran yayını ----------
// Görüntü de ses gibi doğrudan izleyicilere gider; Supabase'den yalnızca "yayında" bilgisi geçer.

$('shareBtn').hidden = !navigator.mediaDevices?.getDisplayMedia; // telefon tarayıcılarında yok
$('shareBtn').addEventListener('click', async () => {
  if (voice.share) return stopShare();
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30, width: { max: 1920 }, height: { max: 1080 } },
      audio: false,
    });
  } catch {
    return; // pencere seçmeden vazgeçildi
  }
  const [track] = stream.getVideoTracks();
  if (!voice.channelId || voice.share) return track.stop();
  track.contentHint = 'motion'; // oyun görüntüsünde akıcılık öncelikli
  track.onended = stopShare; // tarayıcının kendi "Paylaşımı durdur" düğmesi
  voice.share = track;
  syncShare();
  trackMe();
  renderChannels();
});

function stopShare() {
  if (!voice.share) return;
  voice.share.onended = null;
  voice.share.stop();
  voice.share = null;
  syncShare();
  trackMe();
  renderChannels();
}

// Yayınımı izlemek isteyenlerin sessionId'leri.
function viewers() {
  return new Set(presences().filter((p) => p.voice === voice.channelId && p.watching?.includes(sessionId)).map((p) => p.sid));
}

// Yayını yalnızca "İzle" diyenlerin görüntü hattına tak, diğerlerinden çıkar; izlemeyene veri gitmez.
// Hat baştan açık olduğu için yeniden anlaşma gerekmez.
function syncShare() {
  const want = voice.share ? viewers() : new Set();
  const maxBitrate = Math.min(SHARE_PEER_BITRATE, SHARE_TOTAL_BITRATE / want.size);
  for (const [sid, peer] of peers) {
    const sender = peer.video?.sender;
    if (!sender) continue;
    const track = want.has(sid) ? voice.share : null;
    if (sender.track !== track) sender.replaceTrack(track).catch((err) => console.error('share', err));
    if (!track) continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) continue;
    params.encodings[0].maxBitrate = maxBitrate;
    sender.setParameters(params).catch(() => {});
  }
}

function setWatching(sid, on) {
  if (on) watching.add(sid);
  else watching.delete(sid);
  trackMe();
  renderStage();
}

function renderStage() {
  const live = new Map(); // yayın yapanın sessionId'si -> { name, track }; track yalnızca izliyorsak dolu
  if (voice.channelId) {
    for (const p of presences()) {
      if (!p.sharing || p.voice !== voice.channelId || p.sid === sessionId) continue;
      const track = (watching.has(p.sid) && peers.get(p.sid)?.screen) || null;
      live.set(p.sid, { name: p.username, track, key: track ?? watching.has(p.sid) }); // key değişince kutu yeniden çizilir
    }
  }
  // Biten yayının izleme isteği de biter; aynı kişi yeniden yayın açarsa tekrar "İzle" demek gerekir.
  const ended = [...watching].filter((sid) => !live.has(sid));
  for (const sid of ended) watching.delete(sid);
  if (ended.length) trackMe();

  for (const [sid, tile] of tiles) {
    if (live.has(sid) && live.get(sid).key === tile.key) continue;
    tile.node.remove();
    tiles.delete(sid);
  }
  for (const [sid, { name, track, key }] of live) {
    if (tiles.has(sid)) continue;
    let node;
    if (track) {
      const video = el('video', { autoplay: true, muted: true, playsInline: true, srcObject: new MediaStream([track]) });
      const close = el('button', { className: 'close', title: 'İzlemeyi bırak' }, '✕');
      close.setAttribute('aria-label', `${name} yayınını izlemeyi bırak`);
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        setWatching(sid, false);
      });
      node = el('figure', { className: 'tile', title: 'Tam ekran için tıkla' }, video, el('figcaption', {}, name), close);
      node.addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen()));
      video.play().catch(() => {});
    } else {
      const watch = el('button', { className: 'primary' }, watching.has(sid) ? 'Bağlanıyor…' : 'İzle');
      watch.addEventListener('click', () => setWatching(sid, true));
      node = el('div', { className: 'offer' }, el('span', {}, `${name} yayında`), watch);
    }
    tiles.set(sid, { node, key });
    $('stage').append(node);
  }
  $('stage').hidden = !tiles.size;
}

function signal(to, data) {
  lobby.send({ type: 'broadcast', event: 'signal', payload: { from: sessionId, to, data } });
}

function createPeer(sid) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const audio = el('audio', { autoplay: true, muted: voice.deafened });
  $('audios').append(audio);
  const peer = { pc, audio, pending: [], created: Date.now() };
  peers.set(sid, peer);

  for (const track of voice.stream.getTracks()) pc.addTrack(track, voice.stream);
  // Ekran yayını için boş bir görüntü hattı; teklifi yapan açar, karşı taraf onSignal'de kendi yönünü açar.
  // Sesle aynı akışa bağlı: eski sürümdeki istemciler akışı olmayan bir parça gelince sesi kaybediyor.
  if (sessionId < sid) peer.video = pc.addTransceiver('video', { direction: 'sendrecv', streams: [voice.stream] });
  pc.onicecandidate = (e) => e.candidate && signal(sid, { candidate: e.candidate });
  pc.ontrack = (e) => {
    if (e.track.kind === 'video') {
      peer.screen = e.track;
      return renderStage();
    }
    const stream = new MediaStream([e.track]);
    audio.srcObject = stream;
    audio.play().catch(() => {});
    addMeter(sid, stream);
    applyVolumes();
  };
  pc.onconnectionstatechange = () => {
    // Bağlantı koptuysa teklifi yapan taraf yeniden dener.
    if (pc.connectionState === 'failed' && sessionId < sid) sendOffer(sid, { iceRestart: true });
  };
  return peer;
}

function closePeer(sid) {
  const peer = peers.get(sid);
  if (!peer) return;
  peer.pc.close();
  peer.audio.remove();
  removeMeter(sid);
  peers.delete(sid);
}

async function sendOffer(sid, options) {
  const peer = peers.get(sid);
  if (!peer) return;
  try {
    await peer.pc.setLocalDescription(await peer.pc.createOffer(options));
    signal(sid, { sdp: peer.pc.localDescription });
  } catch (err) {
    console.error('offer', err);
  }
}

// Kanaldaki herkesle bağlantı kur, ayrılanları kapat. İki taraftan session id'si
// küçük olan teklifi yapar; böylece aynı anda iki teklif çakışmaz.
function reconcilePeers() {
  if (!voice.channelId) return;
  const here = new Set(presences().filter((p) => p.voice === voice.channelId && p.sid !== sessionId).map((p) => p.sid));
  for (const sid of here) {
    if (peers.has(sid)) continue;
    createPeer(sid);
    if (sessionId < sid) sendOffer(sid);
  }
  for (const [sid, peer] of peers) {
    // Teklif, karşı tarafın durumu bize ulaşmadan gelebilir; yeni bağlantıya biraz süre tanı.
    if (!here.has(sid) && Date.now() - peer.created > 5000) closePeer(sid);
  }
}

async function onSignal({ from, to, data }) {
  if (to !== sessionId || !voice.channelId) return;
  const peer = peers.get(from) ?? createPeer(from);
  const { pc } = peer;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c);
      if (data.sdp.type === 'offer') {
        peer.video ??= pc.getTransceivers().find((t) => t.receiver.track.kind === 'video');
        if (peer.video) peer.video.direction = 'sendrecv';
        await pc.setLocalDescription(await pc.createAnswer());
        signal(from, { sdp: pc.localDescription });
      }
      syncShare();
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else peer.pending.push(data.candidate);
    }
  } catch (err) {
    console.error('signal', err);
  }
}

// ---------- Konuşan kişi göstergesi ----------

function addMeter(sid, stream) {
  removeMeter(sid);
  audioCtx ??= new AudioContext();
  audioCtx.resume();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  meters.set(sid, { source, analyser, buf: new Uint8Array(analyser.fftSize) });
}

function removeMeter(sid) {
  meters.get(sid)?.source.disconnect();
  meters.delete(sid);
}

setInterval(() => {
  for (const [sid, { analyser, buf }] of meters) {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    const speaking = Math.sqrt(sum / buf.length) > 0.03;
    document.querySelector(`[data-sid="${sid}"]`)?.classList.toggle('speaking', speaking);
  }
}, 120);

// ---------- Başlat ----------

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  show('setup');
} else {
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data } = await sb.auth.getSession();
  await route(data.session);
  // Bu geri çağrının içinde doğrudan Supabase isteği yapmak kilitlenmeye yol açar; bir sonraki tura ertele.
  sb.auth.onAuthStateChange((event, session) => setTimeout(() => route(session), 0));
}
