const { contextBridge, ipcRenderer } = require('electron');

// Sitenin (app.js) masaüstü uygulamasında olduğunu anlayıp kullandığı arayüz.
contextBridge.exposeInMainWorld('muhabbetDesktop', {
  // key: { code, ctrl, alt, shift } ya da tuşu bırakmak için null. Tuş kaydedilebildiyse true döner.
  setMuteKey: (key) => ipcRenderer.invoke('set-mute-key', key),
  onToggleMute: (fn) => ipcRenderer.on('toggle-mute', () => fn()),
});
