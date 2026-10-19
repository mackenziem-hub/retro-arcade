// Phone arcade storage. Everything stays on this device:
//   game files  -> Origin Private File System (fast, handles big files)
//   players, game list, saves, snapshots -> IndexedDB
const DB_NAME = 'retro-arcade', DB_VER = 2;
const EJS_DATA = 'https://cdn.emulatorjs.org/4.2.3/data/';
const SNAPSHOT_EVERY = 5 * 60 * 1000;   // keep a rollback snapshot at most this often
const SNAPSHOT_SLOTS = 3;

const SYSTEMS = { gb: 'Game Boy', gba: 'Game Boy Advance', nds: 'Nintendo DS', nes: 'NES', snes: 'SNES',
  n64: 'Nintendo 64', psx: 'PlayStation', psp: 'PSP', segaMD: 'Genesis' };
const COVER_SETS = { gb: 'Nintendo - Game Boy', gbc: 'Nintendo - Game Boy Color', gba: 'Nintendo - Game Boy Advance',
  nds: 'Nintendo - Nintendo DS', nes: 'Nintendo - Nintendo Entertainment System', snes: 'Nintendo - Super Nintendo Entertainment System',
  n64: 'Nintendo - Nintendo 64', psx: 'Sony - PlayStation', psp: 'Sony - PlayStation Portable', segaMD: 'Sega - Mega Drive - Genesis' };
const EXT_SYSTEM = { gb: 'gb', gbc: 'gb', gba: 'gba', nds: 'nds', nes: 'nes', sfc: 'snes', smc: 'snes', z64: 'n64', n64: 'n64', v64: 'n64',
  cue: 'psx', chd: 'psx', pbp: 'psx', cso: 'psp', md: 'segaMD', gen: 'segaMD' };
const AMBIGUOUS = { bin: 'psx', iso: 'psx', zip: '', '7z': '' };

let dbp;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('games')) d.createObjectStore('games', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('users')) d.createObjectStore('users', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('saves')) d.createObjectStore('saves');
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
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
const saveKey = (u, g, kind) => `${u}|${g}|${kind}`;

const Store = {
  SYSTEMS, EJS_DATA,
  meta: { get: k => get('meta', k), set: (k, v) => put('meta', v, k) },

  // Players. Edits are stamped so the family store can tell which side is newer.
  users: () => all('users'),
  async saveUser(u) { await put('users', u); await this.touchProfiles(); },
  async deleteUser(id) { await del('users', id); await this.touchProfiles(); },
  async touchProfiles() { await put('meta', Date.now(), 'profilesAt'); await put('meta', true, 'profilesDirty'); },
  async replaceUsers(users, at) {
    const d = await db();
    await new Promise((res, rej) => { const t = d.transaction('users', 'readwrite'); const s = t.objectStore('users'); s.clear(); users.forEach(u => s.put(u)); t.oncomplete = res; t.onerror = () => rej(t.error); });
    await put('meta', at, 'profilesAt'); await put('meta', false, 'profilesDirty');
  },

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
  async addGame(file, system, onProgress) {
    const title = file.name.replace(/\.[^.]+$/, '');
    // Same id the computer arcade uses, so saves line up across devices.
    const id = title.replace(/[^A-Za-z0-9 ._()\-]/g, '').trim();
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('games', { create: true });
    const fh = await dir.getFileHandle(id + '.' + system, { create: true });
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
    const g = { id, file: id + '.' + system, title, system, name: file.name, size: file.size, added: Date.now(), cover: this.coverUrl(title, system, file.name) };
    await put('games', g);
    return g;
  },
  async gameFile(id) {
    const g = await get('games', id);
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('games');
    return (await dir.getFileHandle(g.file || id)).getFile();
  },
  async removeGame(id) {
    const g = await get('games', id);
    try { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('games'); await dir.removeEntry(g.file || id); } catch {}
    await del('games', id);
  },

  // Saves. A state write also keeps a rollback snapshot every few minutes (3 slots, oldest dropped).
  // Each save records base (the family store time it was last synced at) and dirty (play not sent to the store yet).
  async getSave(user, game, kind) { return (await get('saves', saveKey(user, game, kind))) || null; },
  async putSave(user, game, kind, bytes, at, opts = {}) {
    const prev = await get('saves', saveKey(user, game, kind));
    const base = 'base' in opts ? opts.base : prev ? prev.base : undefined;
    const dirty = 'dirty' in opts ? opts.dirty : true;
    if (kind === 'state') {
      const cur = await get('saves', saveKey(user, game, 'state'));
      const newest = await get('saves', saveKey(user, game, 'state.h1'));
      if (cur && (!newest || cur.at - newest.at >= SNAPSHOT_EVERY)) {
        for (let i = SNAPSHOT_SLOTS - 1; i >= 1; i--) {
          const prev = await get('saves', saveKey(user, game, 'state.h' + i));
          if (prev) await put('saves', prev, saveKey(user, game, 'state.h' + (i + 1)));
        }
        await put('saves', cur, saveKey(user, game, 'state.h1'));
      }
    }
    return put('saves', { at, bytes, base, dirty }, saveKey(user, game, kind));
  },
  // The store now holds this copy (uploaded, or confirmed the same).
  async markSynced(user, game, kind, at) {
    const k = saveKey(user, game, kind), cur = await get('saves', k);
    if (!cur) return;
    await put('saves', { ...cur, base: at, dirty: cur.at === at ? false : cur.dirty }, k);
  },
  // Before a family copy replaces a save with unsent play, keep that copy: snapshots go into the Go back list, others into "<kind>.kept".
  async keepLocal(user, game, kind) {
    const k = saveKey(user, game, kind), cur = await get('saves', k);
    if (!cur || !(cur.dirty || cur.base === undefined)) return;
    if (kind === 'state') {
      for (let i = SNAPSHOT_SLOTS - 1; i >= 1; i--) {
        const prev = await get('saves', saveKey(user, game, 'state.h' + i));
        if (prev) await put('saves', prev, saveKey(user, game, 'state.h' + (i + 1)));
      }
      await put('saves', { at: cur.at, bytes: cur.bytes }, saveKey(user, game, 'state.h1'));
    } else await put('saves', { at: cur.at, bytes: cur.bytes }, saveKey(user, game, kind + '.kept'));
  },
  // Saves with play not yet in the family store (records from before this tracking count too, once).
  async unsentSaves() {
    const d = await db();
    return new Promise(res => {
      const out = [], r = d.transaction('saves').objectStore('saves').openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return res(out);
        const [user, game, kind] = c.key.split('|');
        if (['sram', 'state', 'slot1', 'slot2', 'slot3'].includes(kind) && (c.value.dirty || c.value.base === undefined)) out.push({ user, game, kind, save: c.value });
        c.continue();
      };
    });
  },
  async snapshots(user, game) {
    const out = [];
    for (let i = 1; i <= SNAPSHOT_SLOTS; i++) { const s = await get('saves', saveKey(user, game, 'state.h' + i)); if (s) out.push({ slot: 'h' + i, at: s.at }); }
    return out;
  },
  snapshot: (user, game, slot) => get('saves', saveKey(user, game, 'state.' + slot)),
  async recent(user) {
    const d = await db();
    return new Promise(res => {
      const out = {}, r = d.transaction('saves').objectStore('saves').openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return res(Object.entries(out).map(([id, at]) => ({ id, at })).sort((a, b) => b.at - a.at));
        const [u, g, kind] = c.key.split('|');
        if (u === user && (kind === 'sram' || kind === 'state')) out[g] = Math.max(out[g] || 0, c.value.at);
        c.continue();
      };
    });
  },

  // Whole-saves backup as plain JSON (bytes base64), and the reverse.
  async exportSaves() {
    const d = await db(); const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    return new Promise(res => {
      const out = [], r = d.transaction('saves').objectStore('saves').openCursor();
      r.onsuccess = () => { const c = r.result; if (!c) return res({ arcade: 1, saves: out }); out.push({ key: c.key, at: c.value.at, data: b64(c.value.bytes) }); c.continue(); };
    });
  },
  async importSaves(obj) {
    if (!obj || obj.arcade !== 1 || !Array.isArray(obj.saves)) throw new Error('bad file');
    let n = 0;
    for (const s of obj.saves) {
      const bin = atob(s.data), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const cur = await get('saves', s.key);
      if (!cur || cur.at < s.at) { await put('saves', { at: s.at, bytes }, s.key); n++; }
    }
    return n;
  },
  async usage() { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0 }; },
  persist: () => navigator.storage.persist ? navigator.storage.persist() : Promise.resolve(false),
};
