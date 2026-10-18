// Phone arcade storage. Everything stays on this device:
//   game files  -> Origin Private File System (fast, handles big files)
//   players, game list, saves -> IndexedDB
const DB_NAME = 'retro-arcade', DB_VER = 1;
const EJS_DATA = 'https://cdn.emulatorjs.org/4.2.3/data/';

const SYSTEMS = { gb: 'Game Boy', gba: 'Game Boy Advance', nds: 'Nintendo DS', nes: 'NES', snes: 'SNES',
  n64: 'Nintendo 64', psx: 'PlayStation', psp: 'PSP', segaMD: 'Genesis' };
const COVER_SETS = { gb: 'Nintendo - Game Boy', gbc: 'Nintendo - Game Boy Color', gba: 'Nintendo - Game Boy Advance',
  nds: 'Nintendo - Nintendo DS', nes: 'Nintendo - Nintendo Entertainment System', snes: 'Nintendo - Super Nintendo Entertainment System',
  n64: 'Nintendo - Nintendo 64', psx: 'Sony - PlayStation', psp: 'Sony - PlayStation Portable', segaMD: 'Sega - Mega Drive - Genesis' };
const EXT_SYSTEM = { gb: 'gb', gbc: 'gb', gba: 'gba', nds: 'nds', nes: 'nes', sfc: 'snes', smc: 'snes', z64: 'n64', n64: 'n64', v64: 'n64',
  cue: 'psx', chd: 'psx', pbp: 'psx', cso: 'psp', md: 'segaMD', gen: 'segaMD' };
// Extensions that could be more than one system; the import screen lets you pick.
const AMBIGUOUS = { bin: 'psx', iso: 'psx', zip: '', '7z': '' };

let dbp;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('games', { keyPath: 'id' });
      d.createObjectStore('users', { keyPath: 'id' });
      d.createObjectStore('saves');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out && 'result' in out ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}
const all = store => tx(store, 'readonly', s => s.getAll());
const put = (store, v, k) => tx(store, 'readwrite', s => s.put(v, k));
const del = (store, k) => tx(store, 'readwrite', s => s.delete(k));
const get = (store, k) => tx(store, 'readonly', s => s.get(k));

const Store = {
  SYSTEMS, EJS_DATA,
  users: () => all('users'),
  saveUser: u => put('users', u),
  deleteUser: id => del('users', id),
  games: () => all('games'),
  game: id => get('games', id),

  guessSystem(name, size) {
    const ext = name.split('.').pop().toLowerCase();
    if (EXT_SYSTEM[ext]) return EXT_SYSTEM[ext];
    if (ext === 'iso') return size > 750e6 ? 'psp' : 'psx';
    if (ext in AMBIGUOUS) return AMBIGUOUS[ext];
    return null;
  },
  isGameFile: name => { const e = name.split('.').pop().toLowerCase(); return e in EXT_SYSTEM || e in AMBIGUOUS; },

  coverUrl(title, system, name) {
    const set = /\.gbc$/i.test(name || '') ? COVER_SETS.gbc : COVER_SETS[system];
    const file = title.replace(/[&*/:`<>?\\|"]/g, '_') + '.png';
    return `https://thumbnails.libretro.com/${encodeURIComponent(set)}/Named_Boxarts/${encodeURIComponent(file)}`;
  },

  // Copy a picked file into private storage, streaming so big PlayStation discs do not fill memory.
  async addGame(file, system, onProgress) {
    const title = file.name.replace(/\.[^.]+$/, '');
    const id = title.replace(/[^A-Za-z0-9 ._()\-]/g, '').trim() + '.' + system;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('games', { create: true });
    const fh = await dir.getFileHandle(id, { create: true });
    const w = await fh.createWritable();
    const reader = file.stream().getReader();
    let done = 0;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      await w.write(value); done += value.length;
      onProgress && onProgress(done / file.size);
    }
    await w.close();
    const g = { id, title, system, name: file.name, size: file.size, added: Date.now(), cover: this.coverUrl(title, system, file.name) };
    await put('games', g);
    return g;
  },
  async gameFile(id) {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('games');
    return (await dir.getFileHandle(id)).getFile();
  },
  async removeGame(id) {
    try { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('games'); await dir.removeEntry(id); } catch {}
    await del('games', id);
  },

  // Saves: key "<user>|<game>|sram" or "|state"
  async getSave(user, game, kind) { const v = await get('saves', `${user}|${game}|${kind}`); return v ? v : null; },
  putSave: (user, game, kind, bytes) => put('saves', { at: Date.now(), bytes }, `${user}|${game}|${kind}`),
  async recent(user) {
    const d = await db();
    return new Promise(res => {
      const out = {}, r = d.transaction('saves').objectStore('saves').openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return res(Object.entries(out).map(([id, at]) => ({ id, at })).sort((a, b) => b.at - a.at));
        const [u, g] = c.key.split('|');
        if (u === user) out[g] = Math.max(out[g] || 0, c.value.at);
        c.continue();
      };
    });
  },

  async usage() {
    const e = await navigator.storage.estimate();
    return { used: e.usage || 0, quota: e.quota || 0 };
  },
  persist: () => navigator.storage.persist ? navigator.storage.persist() : Promise.resolve(false),
};
