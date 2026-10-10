// Muhabbet masaüstü uygulaması: siteyi kendi penceresinde açar ve tarayıcının veremediği
// iki şeyi ekler: başka uygulama öndeyken çalışan susturma tuşu ve ekran paylaşımı seçicisi.
// Sitenin kendisi buraya gömülü değil; site güncellenince uygulama da güncellenmiş olur.

const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, session, shell } = require('electron');
const path = require('node:path');

const SITE = 'https://bagost35.github.io/muhabbet/';
const fromSite = (url) => url.startsWith(SITE);

let win = null;

// Sitedeki tuş kaydını ({ code, ctrl, alt, shift }) Electron kısayoluna çevirir; desteklenmeyen tuşta null.
const KEYS = {
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};

function accelerator(key) {
  const code = typeof key?.code === 'string' ? key.code : '';
  let name = KEYS[code];
  if (/^Key[A-Z]$/.test(code)) name = code.slice(3);
  else if (/^Digit\d$/.test(code)) name = code.slice(5);
  else if (/^Numpad\d$/.test(code)) name = 'num' + code.slice(6);
  else if (/^F([1-9]|1\d|2[0-4])$/.test(code)) name = code;
  if (!name) return null;
  return [key.ctrl && 'Control', key.alt && 'Alt', key.shift && 'Shift', name].filter(Boolean).join('+');
}

// Site, ses kanalına girince tuşu kaydettirir, çıkınca (null göndererek) bıraktırır.
// Kayıtlı tuşu Windows yutar: tuş o sırada başka hiçbir uygulamaya gitmez.
ipcMain.handle('set-mute-key', (event, key) => {
  if (!fromSite(event.senderFrame?.url ?? '')) return false;
  globalShortcut.unregisterAll();
  if (!key) return true;
  const acc = accelerator(key);
  if (!acc) return false;
  try {
    return globalShortcut.register(acc, () => win?.webContents.send('toggle-mute'));
  } catch {
    return false;
  }
});

// ---------- Ekran paylaşımı seçicisi ----------

let picker = null; // { window, sources, choose }

function pickSource(sources) {
  return new Promise((resolve) => {
    const window = new BrowserWindow({
      parent: win,
      modal: true,
      width: 760,
      height: 560,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      backgroundColor: '#2b2d31',
      title: 'Ekran paylaş',
      webPreferences: { preload: path.join(__dirname, 'picker-preload.js') },
    });
    const list = sources.map((s) => ({ id: s.id, name: s.name, image: s.thumbnail.toDataURL() }));
    picker = { window, sources: list, choose: resolve };
    window.on('closed', () => {
      picker = null;
      resolve(null);
    });
    window.loadFile('picker.html');
  });
}

ipcMain.handle('picker-sources', (event) => (event.sender === picker?.window.webContents ? picker.sources : []));
ipcMain.on('picker-choose', (event, id) => {
  if (event.sender !== picker?.window.webContents) return;
  picker.choose(id);
  picker.window.close();
});

// ---------- Pencere ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 420,
    minHeight: 500,
    autoHideMenuBar: true,
    backgroundColor: '#313338',
    title: 'Muhabbet',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, // pencere arkadayken ses ve bağlantı yavaşlamasın
    },
  });
  win.on('closed', () => (win = null));
  win.on('page-title-updated', (e) => e.preventDefault());

  // Yalnızca site bu pencerede açılır; başka her bağlantı varsayılan tarayıcıya gider.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (fromSite(url)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  win.loadURL(SITE);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    // Mikrofon gibi izinleri yalnızca siteye ver.
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(fromSite(details.requestingUrl ?? contents.getURL()));
    });

    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      let source;
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
        const id = await pickSource(sources);
        source = sources.find((s) => s.id === id);
      } catch (err) {
        console.error('picker', err);
      }
      try {
        callback(source ? { video: source } : {});
      } catch {
        // seçim yapılmadan kapatıldı; site bunu "vazgeçildi" olarak görür
      }
    });

    createWindow();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
