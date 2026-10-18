// Family save sync. Local storage is always written first, so everything works offline;
// when online, saves and the player list go up to the family store and come down on other devices.
// Newest save wins. The store keeps the last few versions of each save for rollback.
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
      return r.status === 204 ? null : r.json();
    } finally { clearTimeout(t); }
  }

  async function gzip(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); }
  async function gunzip(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); }
  function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

  // One upload per key at a time; the newest bytes win if saves arrive faster than uploads finish.
  const pending = new Map();
  async function upload(player, game, kind, bytes, at) {
    const k = `${player}|${game}|${kind}`;
    pending.set(k, { bytes, at });
    if (pending.get(k).busy) return;
    pending.get(k).busy = true;
    try {
      for (;;) {
        const job = pending.get(k); const { bytes, at } = job; job.taken = true;
        if (ready()) {
          const data = b64(await gzip(bytes));
          await rest('arcade_saves?on_conflict=family,player,game,kind', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify({ family: await familyHash(), player, game, kind, data, size: bytes.length, device: deviceId, updated_at: new Date(at).toISOString() })
          }, 60000);
        }
        if (pending.get(k).bytes === bytes) break;   // nothing newer arrived while uploading
      }
    } catch (e) { console.warn('upload failed', e); }
    finally { pending.delete(k); }
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
    upload,
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
