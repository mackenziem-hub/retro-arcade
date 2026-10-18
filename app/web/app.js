// Retro Arcade menu: player profiles + game library.
// Views live in the URL hash so the browser Back button walks one step at a time:
//   #            -> who's playing?
//   #lib         -> library (all systems)
//   #lib/<sys>   -> library filtered to one system

const SYSTEMS = { gb: 'Game Boy', gba: 'Game Boy Advance', nds: 'Nintendo DS', nes: 'NES', snes: 'SNES',
  n64: 'Nintendo 64', psx: 'PlayStation', psp: 'PSP', segaMD: 'Genesis', gc: 'GameCube & Wii', ps2: 'PlayStation 2', '3ds': 'Nintendo 3DS' };
// These open in a desktop emulator window instead of the browser.
const NATIVE = { gc: 'Dolphin', ps2: 'PCSX2', '3ds': 'Azahar' };
const COLORS = ['#ff5d8f', '#ffc145', '#4ade80', '#38bdf8', '#a78bfa', '#fb923c', '#f472b6', '#e2e8f0'];

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let users = [];
let library = [];
let recent = [];
let query = '';
const app = document.getElementById('app');

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = n => (n.trim()[0] || '?').toUpperCase();
// "Legend of Zelda, The - Ocarina of Time (USA) (Rev 2)" -> "The Legend of Zelda - Ocarina of Time"
const nice = t => t.replace(/\s*\([^)]*\)/g, '').replace(/^(.+?), The(?= - |$)/, 'The $1').replace(/^Pokemon/, 'Pokémon').trim();
// Disc 2+ of multi-disc games stay in the folder for the emulator to swap to, but get no card of their own.
const isExtraDisc = g => /\(Disc [2-9]\)/.test(g.title);
const currentUser = () => users.find(u => u.id === store.get('arcade.user'));

async function loadUsers() {
  users = await (await fetch('/api/users')).json();
  if (!Array.isArray(users)) users = [];
}
async function saveUsers() {
  await fetch('/api/users', { method: 'POST', body: JSON.stringify(users) });
}

function route() {
  const [view, sys] = location.hash.replace(/^#/, '').split('/');
  if (view === 'lib' && currentUser()) return renderLibrary(sys || '');
  renderProfiles();
}

// ---------- Who's playing ----------
function renderProfiles() {
  document.title = 'Retro Arcade';
  app.innerHTML = `
    <div class="profiles">
      <h2>Who's playing?</h2>
      ${users.map(u => `
        <button class="profile" data-id="${esc(u.id)}">
          <div class="avatar" style="background:${esc(u.color)}">${esc(initial(u.name))}</div>
          <div>${esc(u.name)}</div>
        </button>`).join('')}
      <button class="profile add" id="addUser">
        <div class="avatar">+</div><div>Add player</div>
      </button>
    </div>`;
  app.querySelectorAll('.profile[data-id]').forEach(b => {
    b.onclick = () => { store.set('arcade.user', b.dataset.id); location.hash = 'lib'; };
    b.oncontextmenu = e => { e.preventDefault(); editUser(users.find(u => u.id === b.dataset.id)); };
  });
  document.getElementById('addUser').onclick = () => editUser(null);
}

const dlg = document.getElementById('userDlg');
let editing = null, pickedColor = COLORS[0];
function editUser(u) {
  editing = u;
  pickedColor = u ? u.color : COLORS[users.length % COLORS.length];
  document.getElementById('userDlgTitle').textContent = u ? 'Edit player' : 'New player';
  document.getElementById('userName').value = u ? u.name : '';
  document.getElementById('userDelete').hidden = !u;
  const c = document.getElementById('userColors');
  c.innerHTML = COLORS.map(col => `<button type="button" data-c="${col}" style="background:${col}" class="${col === pickedColor ? 'on' : ''}" aria-label="colour"></button>`).join('');
  c.querySelectorAll('button').forEach(b => b.onclick = () => {
    pickedColor = b.dataset.c; c.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  });
  dlg.showModal();
}
document.getElementById('userCancel').onclick = () => dlg.close();
document.getElementById('userDelete').onclick = async () => {
  // Saves stay on disk in the saves folder; this only hides the profile.
  users = users.filter(x => x !== editing); await saveUsers(); dlg.close(); route();
};
document.getElementById('userForm').onsubmit = async e => {
  e.preventDefault();
  const name = document.getElementById('userName').value.trim();
  if (!name) return;
  if (editing) { editing.name = name; editing.color = pickedColor; }
  else {
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'player';
    while (users.some(u => u.id === id)) id += '-2';
    users.push({ id, name, color: pickedColor });
  }
  await saveUsers(); dlg.close(); route();
};

// ---------- Library ----------
async function renderLibrary(sys) {
  const me = currentUser();
  document.title = 'Retro Arcade';
  if (!library.length) library = (await (await fetch('/api/library')).json()).games || [];
  recent = (await (await fetch('/api/recent?user=' + encodeURIComponent(me.id))).json()).recent || [];

  const present = Object.keys(SYSTEMS).filter(s => library.some(g => g.system === s));
  const shown = library.filter(g => !isExtraDisc(g) && (!sys || g.system === sys) && (!query || nice(g.title).toLowerCase().includes(query)))
    .sort((a, b) => nice(a.title).replace(/^The /, '').localeCompare(nice(b.title).replace(/^The /, '')));
  const recentGames = sys || query ? [] : recent.map(r => library.find(g => g.id === r.id)).filter(Boolean).slice(0, 6);

  let sync = { available: false, connected: false };
  try { sync = await (await fetch('/api/sync')).json(); } catch {}
  app.innerHTML = `
    <header class="top">
      <h1>Retro <span>Arcade</span></h1>
      <div class="spacer"></div>
      <input class="search" id="q" type="search" placeholder="Search games" value="${esc(query)}">
      ${sync.available ? `<button class="btn icon" id="gear" title="Family saves">${sync.connected ? '☁' : '☁̸'}</button>` : ''}
      <button class="chip" id="switch" title="Switch player">
        <div class="avatar" style="background:${esc(me.color)}">${esc(initial(me.name))}</div>${esc(me.name)}
      </button>
    </header>
    <nav class="tabs">
      <button class="tab ${!sys ? 'on' : ''}" data-s="">All games</button>
      ${present.map(s => `<button class="tab ${sys === s ? 'on' : ''}" data-s="${s}">${SYSTEMS[s]}</button>`).join('')}
    </nav>
    ${recentGames.length ? `<h3 class="row">Continue playing</h3><div class="grid">${recentGames.map(card).join('')}</div>` : ''}
    <h3 class="row">${sys ? SYSTEMS[sys] : 'All games'} <span class="badge">${shown.length}</span></h3>
    ${shown.length ? `<div class="grid">${shown.map(card).join('')}</div>` : `<div class="empty">No games here yet. Add game files to the games folder.</div>`}`;

  app.querySelectorAll('.tab').forEach(t => t.onclick = () => { location.hash = 'lib' + (t.dataset.s ? '/' + t.dataset.s : ''); });
  app.querySelectorAll('.card').forEach(c => c.onclick = async () => {
    const g = library.find(x => x.id === c.dataset.id);
    const qs = 'game=' + encodeURIComponent(g.id) + '&user=' + encodeURIComponent(me.id);
    if (!g.native) { location.href = '/play.html?' + qs; return; }
    toast(`Opening ${nice(g.title)} in ${NATIVE[g.system]}...`);
    const r = await (await fetch('/api/launch?' + qs, { method: 'POST' })).json().catch(() => ({ ok: false }));
    toast(r.ok ? `${NATIVE[g.system]} is opening. It saves on its own; close its window when you're done.` : (r.error || 'Could not open the game.'));
  });
  document.getElementById('switch').onclick = () => { location.hash = ''; };
  const gear = document.getElementById('gear'); if (gear) gear.onclick = () => openSync(sync.connected);
  const q = document.getElementById('q');
  q.oninput = () => { query = q.value.trim().toLowerCase(); renderLibrary(sys).then(() => { const n = document.getElementById('q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); };
}

function card(g) {
  const r = recent.find(x => x.id === g.id);
  const when = r ? 'Played ' + new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : SYSTEMS[g.system] + (g.native ? ' (opens in ' + NATIVE[g.system] + ')' : '');
  return `<button class="card" data-id="${esc(g.id)}">
    <div class="cover">${g.cover ? `<img src="${g.cover}" alt="" loading="lazy">` : `<div class="ph">${esc(nice(g.title))}</div>`}</div>
    <div class="meta"><div class="t">${esc(nice(g.title))}</div>
    <div class="s">${r ? '<span class="dot"></span> ' : ''}${esc(when)}</div></div>
  </button>`;
}

function toast(msg) {
  const t = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  document.getElementById('toastAct').hidden = true;
  t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 6000);
}

// ---------- Family saves ----------
const syncDlg = document.getElementById('syncDlg');
function openSync(connected) {
  document.getElementById('syncCode').value = '';
  document.getElementById('syncStatus').textContent = connected ? 'Connected. Saves on this computer are shared with the family.' : 'Enter the family code to share saves between devices.';
  document.getElementById('syncDisconnect').hidden = !connected;
  syncDlg.showModal();
}
async function setSyncCode(code) {
  const r = await (await fetch('/api/sync', { method: 'POST', body: JSON.stringify({ code }) })).json();
  if (!r.ok) { document.getElementById('syncStatus').textContent = r.error || 'Could not connect.'; return false; }
  syncDlg.close(); toast(code ? 'Family saves connected.' : 'Family saves disconnected.'); users = await (await fetch('/api/users')).json(); route(); return true;
}
document.getElementById('syncCancel').onclick = () => syncDlg.close();
document.getElementById('syncDisconnect').onclick = () => setSyncCode('');
document.getElementById('syncForm').onsubmit = e => { e.preventDefault(); setSyncCode(document.getElementById('syncCode').value.trim()); };

window.addEventListener('hashchange', route);
loadUsers().then(async () => {
  if (!users.length) {
    users = [{ id: 'player-1', name: 'Player 1', color: '#38bdf8' }, { id: 'player-2', name: 'Player 2', color: '#ff5d8f' }];
    await saveUsers();
  }
  route();
});
