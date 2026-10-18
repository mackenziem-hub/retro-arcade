// Phone arcade menu: players + library. Same look and flow as the computer arcade,
// but games and saves are stored on this device (and shared through the family store when connected).
// Views live in the URL hash so Back walks one step: # players, #lib library, #lib/<sys> one system.
const COLORS = ['#ff5d8f', '#ffc145', '#4ade80', '#38bdf8', '#a78bfa', '#fb923c', '#f472b6', '#e2e8f0'];
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = n => (n.trim()[0] || '?').toUpperCase();
const nice = t => t.replace(/\s*\([^)]*\)/g, '').replace(/^(.+?), The(?= - |$)/, 'The $1').replace(/^Pokemon/, 'Pokémon').trim();
const mb = n => n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB';

let users = [], library = [], recent = [], query = '';
const me = () => users.find(u => u.id === ls.get('arcade.user'));
const cloudAvailable = () => !!(window.ARCADE_CLOUD && window.ARCADE_CLOUD.url);

function toast(msg, ms = 4000) {
  const t = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  document.getElementById('toastAct').hidden = true;
  t.classList.add('show');
  clearTimeout(toast.timer); if (ms) toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

// Player list: whichever side (this phone or the family store) changed most recently wins.
async function syncProfiles() {
  if (!Sync.ready()) return;
  try {
    const at = (await Store.meta.get('profilesAt')) || 0, dirty = await Store.meta.get('profilesDirty');
    const pulled = await Sync.pullProfiles(at);
    if (pulled) { await Store.replaceUsers(pulled.users, pulled.at); users = pulled.users; }
    else if (dirty) { await Sync.pushProfiles(users, at || Date.now()); await Store.meta.set('profilesDirty', false); }
  } catch (e) { console.warn('profile sync failed', e); }
}

async function route() {
  users = await Store.users();
  if (!users.length) {
    // A fresh device starts with one player; not marked as an edit, so the family's list wins once connected.
    await Store.replaceUsers([{ id: 'player-1', name: 'Player 1', color: COLORS[3] }], 0);
    users = await Store.users();
  }
  await syncProfiles();
  const [view, sys] = location.hash.replace(/^#/, '').split('/');
  if (view === 'lib' && me()) return renderLibrary(sys || '');
  renderProfiles();
}

// ---------- Who's playing ----------
function renderProfiles() {
  const cloud = cloudAvailable() ? (Sync.configured() ? '' : `<p class="hint">Saves on this phone only. <button class="link" id="connect">Connect family saves</button></p>`) : '';
  app.innerHTML = `
    <div class="profiles">
      <h2>Who's playing?</h2>
      ${users.map(u => `<button class="profile" data-id="${esc(u.id)}">
          <div class="avatar" style="background:${esc(u.color)}">${esc(initial(u.name))}</div><div>${esc(u.name)}</div></button>`).join('')}
      <button class="profile add" id="addUser"><div class="avatar">+</div><div>Add player</div></button>
    </div>
    <p class="hint">Press and hold a player to rename them.</p>${cloud}`;
  app.querySelectorAll('.profile[data-id]').forEach(b => {
    b.onclick = () => { ls.set('arcade.user', b.dataset.id); location.hash = 'lib'; };
    b.oncontextmenu = e => { e.preventDefault(); editUser(users.find(u => u.id === b.dataset.id)); };
  });
  document.getElementById('addUser').onclick = () => editUser(null);
  const c = document.getElementById('connect'); if (c) c.onclick = openSync;
}

const dlg = document.getElementById('userDlg');
let editing = null, pickedColor = COLORS[0];
function editUser(u) {
  editing = u;
  pickedColor = u ? u.color : COLORS[users.length % COLORS.length];
  document.getElementById('userDlgTitle').textContent = u ? 'Edit player' : 'New player';
  document.getElementById('userName').value = u ? u.name : '';
  document.getElementById('userDelete').hidden = !u || users.length < 2;
  const c = document.getElementById('userColors');
  c.innerHTML = COLORS.map(col => `<button type="button" data-c="${col}" style="background:${col}" class="${col === pickedColor ? 'on' : ''}" aria-label="colour"></button>`).join('');
  c.querySelectorAll('button').forEach(b => b.onclick = () => { pickedColor = b.dataset.c; c.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
  dlg.showModal();
}
document.getElementById('userCancel').onclick = () => dlg.close();
document.getElementById('userDelete').onclick = async () => { await Store.deleteUser(editing.id); dlg.close(); route(); };
document.getElementById('userForm').onsubmit = async e => {
  e.preventDefault();
  const name = document.getElementById('userName').value.trim();
  if (!name) return;
  let u = editing;
  if (!u) {
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'player';
    while (users.some(x => x.id === id)) id += '-2';
    u = { id };
  }
  u.name = name; u.color = pickedColor;
  await Store.saveUser(u); dlg.close(); route();
};

// ---------- Family saves ----------
const syncDlg = document.getElementById('syncDlg');
function openSync() {
  document.getElementById('syncCode').value = '';
  document.getElementById('syncStatus').textContent = Sync.configured() ? 'Connected. Saves on this phone are shared with the family.' : 'Enter the family code to share saves between devices.';
  document.getElementById('syncDisconnect').hidden = !Sync.configured();
  syncDlg.showModal();
}
document.getElementById('syncCancel').onclick = () => syncDlg.close();
document.getElementById('syncDisconnect').onclick = async () => { Sync.configure(window.ARCADE_CLOUD.url, window.ARCADE_CLOUD.key, ''); syncDlg.close(); toast('Family saves disconnected. Saves stay on this phone.'); route(); };
document.getElementById('syncForm').onsubmit = async e => {
  e.preventDefault();
  const code = document.getElementById('syncCode').value.trim();
  if (code.length < 8) { document.getElementById('syncStatus').textContent = 'The family code needs at least 8 characters.'; return; }
  Sync.configure(window.ARCADE_CLOUD.url, window.ARCADE_CLOUD.key, code);
  try {
    await Sync.test();
    // First connection: take the family's player list if there is one, otherwise share this phone's.
    const pulled = await Sync.pullProfiles(0);
    if (pulled) { await Store.replaceUsers(pulled.users, pulled.at); }
    else { const at = Date.now(); await Sync.pushProfiles(users, at); await Store.meta.set('profilesAt', at); await Store.meta.set('profilesDirty', false); }
    syncDlg.close(); toast('Family saves connected.'); route();
  } catch (err) {
    Sync.configure(window.ARCADE_CLOUD.url, window.ARCADE_CLOUD.key, '');
    document.getElementById('syncStatus').textContent = 'Could not connect. Check the internet connection and the code.';
  }
};

// ---------- Library ----------
async function renderLibrary(sys) {
  const user = me();
  library = await Store.games();
  recent = await Store.recent(user.id);
  try { for (const r of await Sync.recent(user.id)) { const l = recent.find(x => x.id === r.id); if (l) l.at = Math.max(l.at, r.at); else recent.push(r); } } catch {}
  recent.sort((a, b) => b.at - a.at);
  const present = Object.keys(Store.SYSTEMS).filter(s => library.some(g => g.system === s));
  const shown = library.filter(g => (!sys || g.system === sys) && (!query || nice(g.title).toLowerCase().includes(query)))
    .sort((a, b) => nice(a.title).replace(/^The /, '').localeCompare(nice(b.title).replace(/^The /, '')));
  const recentGames = sys || query ? [] : recent.map(r => library.find(g => g.id === r.id)).filter(Boolean).slice(0, 6);
  const { used } = await Store.usage();
  const cloudNote = cloudAvailable() ? (Sync.configured() ? ' Family saves on.' : ' <button class="link" id="connect">Connect family saves</button>') : '';

  app.innerHTML = `
    <header class="top">
      <h1>Retro <span>Arcade</span></h1>
      <div class="spacer"></div>
      ${cloudAvailable() ? `<button class="btn icon" id="gear" title="Family saves">${Sync.configured() ? '☁' : '☁̸'}</button>` : ''}
      <button class="chip" id="switch" title="Switch player">
        <div class="avatar" style="background:${esc(user.color)}">${esc(initial(user.name))}</div>${esc(user.name)}
      </button>
    </header>
    <div class="bar">
      <input class="search" id="q" type="search" placeholder="Search games" value="${esc(query)}">
      <button class="btn primary" id="add">+ Add games</button>
    </div>
    ${library.length ? `<nav class="tabs">
      <button class="tab ${!sys ? 'on' : ''}" data-s="">All</button>
      ${present.map(s => `<button class="tab ${sys === s ? 'on' : ''}" data-s="${s}">${Store.SYSTEMS[s]}</button>`).join('')}
    </nav>` : ''}
    ${recentGames.length ? `<h3 class="row">Continue playing</h3><div class="grid">${recentGames.map(card).join('')}</div>` : ''}
    ${library.length ? `<h3 class="row">${sys ? Store.SYSTEMS[sys] : 'All games'} <span class="badge">${shown.length}</span></h3>
      <div class="grid">${shown.map(card).join('')}</div>
      <p class="hint">Press and hold a game to remove it. Games and saves use ${mb(used)} on this phone.${cloudNote}</p>`
    : `<div class="empty"><p>No games on this phone yet.</p>
       <p>Tap <b>+ Add games</b> and pick game files from your phone's storage
       (for example the Games folder you copied over).</p></div>`}`;

  app.querySelectorAll('.tab').forEach(t => t.onclick = () => { location.hash = 'lib' + (t.dataset.s ? '/' + t.dataset.s : ''); });
  app.querySelectorAll('.card').forEach(c => {
    c.onclick = () => { location.href = 'play.html?game=' + encodeURIComponent(c.dataset.id) + '&user=' + encodeURIComponent(user.id); };
    c.oncontextmenu = async e => {
      e.preventDefault();
      const g = library.find(x => x.id === c.dataset.id);
      if (confirm(`Remove ${nice(g.title)} from this phone? Saves are kept.`)) { await Store.removeGame(g.id); renderLibrary(sys); }
    };
  });
  document.getElementById('switch').onclick = () => { location.hash = ''; };
  document.getElementById('add').onclick = () => document.getElementById('picker').click();
  const gear = document.getElementById('gear'); if (gear) gear.onclick = openSync;
  const connect = document.getElementById('connect'); if (connect) connect.onclick = openSync;
  const q = document.getElementById('q');
  q.oninput = () => { query = q.value.trim().toLowerCase(); renderLibrary(sys).then(() => { const n = document.getElementById('q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); };
}

function card(g) {
  const r = recent.find(x => x.id === g.id);
  const when = r ? 'Played ' + new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : Store.SYSTEMS[g.system];
  return `<button class="card" data-id="${esc(g.id)}">
    <div class="cover"><img src="${esc(g.cover)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:${esc(JSON.stringify(nice(g.title)))}}))"></div>
    <div class="meta"><div class="t">${esc(nice(g.title))}</div><div class="s">${r ? '<span class="dot"></span> ' : ''}${esc(when)}</div></div>
  </button>`;
}

// ---------- Adding games ----------
const picker = document.getElementById('picker');
const importDlg = document.getElementById('importDlg');
let picked = [];
picker.onchange = () => {
  picked = [...picker.files].filter(f => Store.isGameFile(f.name));
  const skipped = picker.files.length - picked.length;
  picker.value = '';
  if (!picked.length) { toast('Those files are not games the phone arcade can play.'); return; }
  const opts = s => `<option value="">Skip</option>` + Object.entries(Store.SYSTEMS).map(([k, v]) => `<option value="${k}" ${k === s ? 'selected' : ''}>${v}</option>`).join('');
  document.getElementById('importList').innerHTML = picked.map((f, i) => `
    <div class="imp"><div class="imp-name">${esc(nice(f.name.replace(/\.[^.]+$/, '')))}<small>${mb(f.size)}</small></div>
    <select data-i="${i}">${opts(Store.guessSystem(f.name, f.size))}</select></div>`).join('') +
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
    catch (e) { toast(e.name === 'QuotaExceededError' ? 'The phone is out of space.' : 'Could not add ' + f.name); break; }
  }
  await Store.persist();
  bar.style.width = '0'; importDlg.close();
  toast(`Added ${jobs.length} game${jobs.length === 1 ? '' : 's'}.`);
  route();
};

Sync.load();
window.addEventListener('hashchange', route);
window.addEventListener('online', () => syncProfiles());
route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
