// Phone backend for the shared arcade menu: games and saves live on this phone,
// the player list and saves are shared through the family store when it is connected.
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mb = n => n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB';
const cloud = window.ARCADE_CLOUD || {};
Sync.load();

// Player list: whichever side (this phone or the family store) changed most recently wins.
async function syncProfiles(users) {
  if (!Sync.ready()) return users;
  try {
    const at = (await Store.meta.get('profilesAt')) || 0, dirty = await Store.meta.get('profilesDirty');
    const pulled = await Sync.pullProfiles(at);
    if (pulled) { await Store.replaceUsers(pulled.users, pulled.at); return pulled.users; }
    if (dirty && users.length) { await Sync.pushProfiles(users, at || Date.now()); await Store.meta.set('profilesDirty', false); }
  } catch (e) { console.warn('profile sync failed', e); }
  return users;
}

// Web games open in their own window and need no download (same list as the computer arcade).
const WEB_GAMES = [
  { id: 'Aetheria', title: 'Aetheria', system: 'web', link: 'https://pwa-six-iota.vercel.app', cover: 'cover-aetheria.png', added: 1792425600000 },
  { id: 'Aetheria Starfall', title: 'Aetheria Starfall', system: 'web', link: 'https://aetheria-starfall.vercel.app', cover: 'cover-starfall.png', added: 1792425600000 },
];
const backend = {
  users: async () => { try { await Sync.flushPlaytime(); } catch {} return syncProfiles(await Store.users()); },
  async saveUsers(list) {
    const at = Date.now();
    await Store.replaceUsers(list, at); await Store.meta.set('profilesDirty', true);
    if (Sync.ready()) { try { await Sync.pushProfiles(list, at); await Store.meta.set('profilesDirty', false); } catch (e) { console.warn('push failed', e); } }
  },
  games: async () => [...await Store.games(), ...WEB_GAMES],
  async recent(u) {
    const local = await Store.recent(u);
    try { for (const r of await Sync.recent(u)) { const l = local.find(x => x.id === r.id); if (l) l.at = Math.max(l.at, r.at); else local.push(r); } } catch {}
    return local;
  },
  play: (g, user) => { if (g.link) { window.open(g.link, '_blank'); return; } location.href = 'play.html?game=' + encodeURIComponent(g.id) + '&user=' + encodeURIComponent(user.id); },
  sync: {
    available: !!cloud.url,
    connected: () => Sync.configured(),
    async connect(code, create) {
      Sync.configure(cloud.url, cloud.key, code);
      try {
        await Sync.test();
        // A typo must not quietly start an empty family: unknown codes need the separate "Start a new family" choice.
        if (!create && !(await Sync.familyExists())) {
          Sync.configure(cloud.url, cloud.key, '');
          return { ok: false, unknown: true, error: 'No family uses that code. Check it for typos. If you are starting family saves for the first time, choose Start a new family.' };
        }
        // First connection: take the family's player list if there is one, otherwise share this phone's.
        const pulled = await Sync.pullProfiles(0);
        if (pulled) await Store.replaceUsers(pulled.users, pulled.at);
        else { const users = await Store.users(); if (users.length) { const at = Date.now(); await Sync.pushProfiles(users, at); await Store.meta.set('profilesAt', at); await Store.meta.set('profilesDirty', false); } }
        return { ok: true };
      } catch (e) { Sync.configure(cloud.url, cloud.key, ''); return { ok: false }; }
    },
    disconnect: async () => { Sync.configure(cloud.url, cloud.key, ''); },
  },
  extras: [{ label: '+ Add games', onclick: () => document.getElementById('picker').click() }],
  gameActions: g => g.link ? [] : [{ label: 'Remove from this phone (saves are kept)', onclick: async () => { await Store.removeGame(g.id); } }],
  settingsActions: [
    { label: 'Back up saves to a file', onclick: backupSaves },
    { label: 'Restore saves from a file', onclick: () => document.getElementById('restorePicker').click() },
  ],
  usage: async () => { const { used } = await Store.usage(); return 'Games and saves use ' + mb(used) + ' on this phone.'; },
};
const menu = ArcadeMenu(backend);

// ---------- Adding games ----------
const picker = document.getElementById('picker');
const importDlg = document.getElementById('importDlg');
let picked = [];
picker.onchange = () => {
  picked = [...picker.files].filter(f => Store.isGameFile(f.name));
  const skipped = picker.files.length - picked.length;
  picker.value = '';
  if (!picked.length) { menu.toast('Those files are not games the phone arcade can play.'); return; }
  const opts = s => `<option value="">Skip</option>` + Object.entries(Store.SYSTEMS).map(([k, v]) => `<option value="${k}" ${k === s ? 'selected' : ''}>${v}</option>`).join('');
  document.getElementById('importList').innerHTML = picked.map((f, i) => `
    <div class="imp"><div class="imp-name">${esc(f.name.replace(/\.[^.]+$/, ''))}<small>${mb(f.size)}</small></div>
    <select data-i="${i}" data-nav>${opts(Store.guessSystem(f.name, f.size))}</select></div>`).join('') +
    (skipped ? `<p class="hint">${skipped} other file(s) were not game files and were left out.</p>` : '');
  document.getElementById('importGo').disabled = false;
  importDlg.showModal();
};
document.getElementById('importCancel').onclick = () => importDlg.close();
document.getElementById('importGo').onclick = async () => {
  const go = document.getElementById('importGo'); go.disabled = true;
  const jobs = [...document.querySelectorAll('#importList select')].map(s => ({ f: picked[+s.dataset.i], sys: s.value })).filter(j => j.sys);
  const bar = document.getElementById('importBar');
  for (let i = 0; i < jobs.length; i++) {
    const { f, sys } = jobs[i];
    try { await Store.addGame(f, sys, p => { bar.style.width = ((i + p) / jobs.length * 100) + '%'; }); }
    catch (e) { menu.toast(e.name === 'QuotaExceededError' ? 'The phone is out of space.' : 'Could not add ' + f.name); break; }
  }
  await Store.persist();
  bar.style.width = '0'; importDlg.close();
  menu.toast(`Added ${jobs.length} game${jobs.length === 1 ? '' : 's'}.`);
  menu.route();
};

// ---------- Backup / restore ----------
async function backupSaves() {
  const data = await Store.exportSaves();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'retro-arcade-saves-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  menu.toast('Backup file created.');
}
document.getElementById('restorePicker').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { const n = await Store.importSaves(JSON.parse(await f.text())); menu.toast(`Restored ${n} save${n === 1 ? '' : 's'}.`); menu.route(); }
  catch { menu.toast('That file is not an arcade backup.'); }
};

// Saves made offline go up as soon as the phone is back online, and whenever the arcade opens.
window.addEventListener('online', () => { Sync.flush().catch(() => {}); Sync.flushPlaytime().catch(() => {}); menu.route(); });
Sync.flush().catch(() => {});
menu.route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
