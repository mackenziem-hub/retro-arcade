// Family save sync. Local storage is always written first, so everything works offline;
// when online, saves and the player list go up to the family store and come down on other devices.
// A save only replaces the store's copy when the store still holds the version this phone last synced
// (or one this phone wrote). If another device saved since, nothing is overwritten: the family copy wins
// the next time the game opens and this phone's copy is kept. The store keeps the last few versions for rollback.
const PLAYTIME_EVERY = 5 * 60 * 1000;   // how often playtime goes to the family store
const Sync = (() => {
  const cfg = { url: '', key: '', family: '' };
  let deviceId = null;
  const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } },
               set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

  function load() {
    try { Object.assign(cfg, JSON.parse(ls.get('arcade.sync') || '{}')); } catch {}
    deviceId = ls.get('arcade.device') || (() => { const d = 'ph-' + Math.random().toString(36).slice(2, 8); ls.set('arcade.device', d); return d; })();
  }
  const ready = () => !!(cfg.url && cfg.key && cfg.family && navigator.onLine);
  const headers = extra => ({ apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'x-family': cfg.family, ...extra });
  async function rest(path, opts = {}, timeout = 15000) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(cfg.url.replace(/\/$/, '') + '/rest/v1/' + path, { ...opts, headers: headers(opts.headers), signal: ctl.signal });
      if (!r.ok) throw new Error('sync ' + r.status + ' ' + (await r.text()).slice(0, 120));
      const text = await r.text();   // inserts and upserts answer with an empty body
      return text ? JSON.parse(text) : null;
    } finally { clearTimeout(t); }
  }

  async function gzip(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); }
  async function gunzip(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); }
  function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

  // Uploads run one at a time per save; a queued upload is skipped when a newer one for the same save is waiting.
  // Resolves to { result: 'ok' | 'conflict' | 'offline' | 'skipped' | 'error', device? }.
  const chains = new Map(), latest = new Map();
  let playFlush = null;   // the playtime send in progress, if any
  const savePath = (player, game, kind) => `arcade_saves?player=eq.${encodeURIComponent(player)}&game=eq.${encodeURIComponent(game)}&kind=eq.${kind}`;
  function upload(player, game, kind, bytes, at, base) {
    const k = `${player}|${game}|${kind}`;
    latest.set(k, at);
    const run = async () => {
      if (latest.get(k) !== at) return { result: 'skipped' };
      if (!ready()) return { result: 'offline' };
      try {
        const meta = (await rest(savePath(player, game, kind) + '&select=updated_at,device', {}, 8000))[0];
        if (meta) {
          const cAt = new Date(meta.updated_at).getTime();
          if (cAt > (base || 0) + 1000 && meta.device !== deviceId) return { result: 'conflict', device: meta.device };
        }
        const data = b64(await gzip(bytes));
        await rest('arcade_saves?on_conflict=family,player,game,kind', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ family: await familyHash(), player, game, kind, data, size: bytes.length, device: deviceId, updated_at: new Date(at).toISOString() })
        }, 60000);
        return { result: 'ok' };
      } catch (e) { console.warn('upload failed', e); return { result: 'error' }; }
    };
    const p = (chains.get(k) || Promise.resolve()).then(run, run);
    chains.set(k, p.catch(() => {}));
    return p;
  }

  let hashCache;
  async function familyHash() {
    if (hashCache) return hashCache;
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cfg.family));
    return hashCache = [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  return {
    load, ready: () => ready(), configured: () => !!(cfg.url && cfg.key && cfg.family), deviceId: () => deviceId,
    configure(url, key, family) { Object.assign(cfg, { url, key, family }); hashCache = null; ls.set('arcade.sync', JSON.stringify(cfg)); },
    async test() { await rest('arcade_recent?select=game&limit=1'); return true; },
    // True when a family already uses the current code (it has a player list or saves). Throws when offline.
    async familyExists() {
      if ((await rest('arcade_profiles?select=family', {}, 10000) || []).length) return true;
      return (await rest('arcade_saves?select=game&limit=1', {}, 10000) || []).length > 0;
    },
    upload,
    // Sends every save this phone has not sent yet (played offline, or before this tracking existed).
    // Older records with no sync time are only sent when they are newer than the store's copy.
    async flush() {
      if (!ready()) return 0;
      let sent = 0;
      for (const { user, game, kind, save } of await Store.unsentSaves()) {
        const base = save.base !== undefined ? save.base : save.at;
        const r = await upload(user, game, kind, save.bytes, save.at, base);
        if (r.result === 'ok') { await Store.markSynced(user, game, kind, save.at); sent++; }
        else if (r.result === 'conflict' && save.base === undefined) {
          // Old record and the store is newer: nothing to send; the store's copy comes down when the game opens.
        }
      }
      return sent;
    },
    // Returns {bytes, at} of the store's copy, whatever its time, or null if there is none.
    async fetchLatest(player, game, kind) {
      if (!ready()) return null;
      const row = (await rest(savePath(player, game, kind) + '&select=data,updated_at', {}, 60000))[0];
      return row ? { bytes: await gunzip(unb64(row.data)), at: new Date(row.updated_at).getTime() } : null;
    },
    // Returns {bytes, at} if the family store has a newer copy than localAt, else null.
    async fetchNewer(player, game, kind, localAt) {
      if (!ready()) return null;
      const q = `arcade_saves?select=updated_at&player=eq.${encodeURIComponent(player)}&game=eq.${encodeURIComponent(game)}&kind=eq.${kind}`;
      const meta = (await rest(q, {}, 8000))[0];
      if (!meta || new Date(meta.updated_at).getTime() <= (localAt || 0) + 1000) return null;
      const row = (await rest(q.replace('select=updated_at', 'select=data,updated_at'), {}, 60000))[0];
      return { bytes: await gunzip(unb64(row.data)), at: new Date(row.updated_at).getTime() };
    },
    async recent(player) {
      if (!ready()) return [];
      return (await rest(`arcade_recent?select=game,updated_at&player=eq.${encodeURIComponent(player)}`, {}, 8000))
        .map(r => ({ id: r.game, at: new Date(r.updated_at).getTime() }));
    },
    async history(player, game, kind) {
      if (!ready()) return [];
      return rest(`arcade_save_history?select=id,updated_at,device&player=eq.${encodeURIComponent(player)}&game=eq.${encodeURIComponent(game)}&kind=eq.${kind}&order=updated_at.desc`, {}, 8000);
    },
    async historyBytes(id) { const r = (await rest(`arcade_save_history?select=data,updated_at&id=eq.${id}`, {}, 60000))[0]; return { bytes: await gunzip(unb64(r.data)), at: new Date(r.updated_at).getTime() }; },
    // Playtime is counted on this phone and sent every few minutes. Each send first takes the family's latest
    // player list and adds only this phone's new minutes, so it never undoes a change made on another device
    // (a hidden game, a new player, kid mode). Without a family code it simply counts on the phone.
    async addPlaytime(userId, gameId, mins) {
      if (!this.configured()) {
        const users = await Store.users(), u = users.find(x => x.id === userId); if (!u) return;
        u.play = u.play || {}; u.play[gameId] = (u.play[gameId] || 0) + mins;
        await Store.replaceUsers(users, Date.now()); return;
      }
      const pend = (await Store.meta.get('playPending')) || {};
      const k = userId + '|' + gameId; pend[k] = (pend[k] || 0) + mins;
      await Store.meta.set('playPending', pend);
      if (Date.now() - ((await Store.meta.get('playSentAt')) || 0) >= PLAYTIME_EVERY) await this.flushPlaytime();
    },
    // One send at a time: the minutes are taken off the pile first, and put back if the send fails.
    flushPlaytime() {
      if (playFlush) return playFlush;
      playFlush = (async () => {
        const pend = (await Store.meta.get('playPending')) || {};
        if (!Object.keys(pend).length || !ready()) return;   // offline: the minutes wait on the phone
        await Store.meta.set('playPending', {});
        let applied = false;
        try {
          let users = await Store.users();
          const pulled = await this.pullProfiles((await Store.meta.get('profilesAt')) || 0);   // throws if the store cannot be reached
          if (pulled) { await Store.replaceUsers(pulled.users, pulled.at); users = pulled.users; }
          for (const [k, mins] of Object.entries(pend)) {
            const [userId, gameId] = k.split('|'), u = users.find(x => x.id === userId);
            if (u) { u.play = u.play || {}; u.play[gameId] = (u.play[gameId] || 0) + mins; }
          }
          const at = Date.now();
          await Store.replaceUsers(users, at); applied = true;
          await Store.meta.set('playSentAt', at);
          await this.pushProfiles(users, at);
        } catch (e) {
          if (applied) await Store.meta.set('profilesDirty', true);   // counted on the phone; the list goes up with the next sync
          else {                                                       // nothing counted yet: put the minutes back
            const now = (await Store.meta.get('playPending')) || {};
            for (const [k, mins] of Object.entries(pend)) now[k] = (now[k] || 0) + mins;
            await Store.meta.set('playPending', now);
          }
          throw e;
        }
      })().finally(() => { playFlush = null; });
      return playFlush;
    },
    // Player list: whichever side changed most recently wins.
    async pullProfiles(localAt) {
      if (!ready()) return null;
      const row = (await rest('arcade_profiles?select=data,updated_at', {}, 8000))[0];
      return row && new Date(row.updated_at).getTime() > (localAt || 0) + 1000 ? { users: row.data, at: new Date(row.updated_at).getTime() } : null;
    },
    async pushProfiles(users, at) {
      if (!ready()) return;
      await rest('arcade_profiles?on_conflict=family', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ family: await familyHash(), data: users, updated_at: new Date(at).toISOString() }) }, 15000);
    },
  };
})();
