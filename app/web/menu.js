// Arcade menu shared by the computer arcade and the phone app. The page supplies a backend:
//   users() / saveUsers(list)      player list (the backend syncs it through the family store)
//   games()                        [{id, title, system, cover, native?, added?}]
//   recent(userId)                 [{id, at}]
//   play(game, user)               opens the game
//   sync                           { available, connected(), connect(code) -> {ok,error}, disconnect() }   optional
//   extras                         [{ label, onclick }] buttons beside the search box                      optional
//   gameActions(game, user)        extra items for a game's long-press menu                               optional
//   settingsActions                extra buttons in the Family saves dialog                               optional
//   usage()                        text for the footer                                                    optional
// Profiles: { id, name, color, kid?, favs?: [gameId], play?: { gameId: minutes } }.
// A hidden "_settings" entry in the same list carries hiddenForKids: [gameId] so it syncs like the players do.
window.ArcadeMenu = function (backend) {
  const SYSTEMS = { gb: 'Game Boy', gba: 'Game Boy Advance', nds: 'Nintendo DS', nes: 'NES', snes: 'SNES', n64: 'Nintendo 64',
    psx: 'PlayStation', psp: 'PSP', segaMD: 'Genesis', gc: 'GameCube & Wii', ps2: 'PlayStation 2', '3ds': 'Nintendo 3DS' };
  const NATIVE = { gc: 'Dolphin', ps2: 'PCSX2', '3ds': 'Azahar' };
  const COLORS = ['#ff5d8f', '#ffc145', '#4ade80', '#38bdf8', '#a78bfa', '#fb923c', '#f472b6', '#e2e8f0'];
  const NEW_DAYS = 7;
  const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  const app = document.getElementById('app');
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initial = n => (n.trim()[0] || '?').toUpperCase();
  const nice = t => t.replace(/\s*\([^)]*\)/g, '').replace(/^(.+?), The(?= - |$)/, 'The $1').replace(/^Pokemon/, 'Pokémon').trim();
  const sortKey = g => nice(g.title).replace(/^The /, '');
  const fmtTime = m => m < 1 ? '' : m < 60 ? Math.round(m) + ' min' : Math.floor(m / 60) + 'h ' + (Math.round(m % 60) ? Math.round(m % 60) + 'm' : '');

  let all = [], users = [], library = [], recent = [], query = '';
  let sort = ls.get('arcade.sort') || 'az';
  const settings = () => all.find(u => u.id === '_settings') || (all.push({ id: '_settings', hiddenForKids: [] }), all[all.length - 1]);
  const me = () => users.find(u => u.id === ls.get('arcade.user'));
  const saveAll = async () => { await backend.saveUsers(all); };

  function toast(msg, ms = 4000) {
    const t = $('toast'); $('toastMsg').textContent = msg; $('toastAct').hidden = true;
    t.classList.add('show'); clearTimeout(toast.timer); if (ms) toast.timer = setTimeout(() => t.classList.remove('show'), ms);
  }

  async function load() {
    all = await backend.users();
    if (!Array.isArray(all)) all = [];
    users = all.filter(u => u.id !== '_settings' && u.name);
  }
  async function route() {
    await load();
    const [view, sys] = location.hash.replace(/^#/, '').split('/');
    document.body.classList.toggle('kid', !!(me() && me().kid));
    if (!users.length) return renderWelcome();
    if (view === 'lib' && me()) return renderLibrary(sys || '');
    renderProfiles();
  }

  // ---------- Welcome (new device, no players yet) ----------
  function renderWelcome() {
    const sync = backend.sync && backend.sync.available && !backend.sync.connected();
    app.innerHTML = `
      <div class="welcome">
        <h1>Retro <span>Arcade</span></h1>
        <p>Who plays here?</p>
        <form id="welcomeForm" class="bar">
          <input class="search" id="welcomeName" type="text" maxlength="20" placeholder="Your name" autocomplete="off" required data-nav>
          <button type="submit" class="btn primary" data-nav>Start</button>
        </form>
        ${sync ? `<p class="hint">Already playing on another device? <button class="link" id="welcomeSync" data-nav>Enter the family code</button></p>` : ''}
      </div>`;
    $('welcomeForm').onsubmit = async e => {
      e.preventDefault();
      const name = $('welcomeName').value.trim(); if (!name) return;
      all.push({ id: idFor(name), name, color: COLORS[3] }); await saveAll();
      ls.set('arcade.user', idFor(name)); location.hash = 'lib'; route();
    };
    const s = $('welcomeSync'); if (s) s.onclick = openSync;
    $('welcomeName').focus();
  }
  const idFor = name => { let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'player'; while (all.some(u => u.id === id)) id += '-2'; return id; };

  // ---------- Who's playing ----------
  function renderProfiles() {
    const sync = backend.sync && backend.sync.available;
    app.innerHTML = `
      <div class="profiles">
        <h2>Who's playing?</h2>
        ${users.map(u => `<button class="profile" data-id="${esc(u.id)}" data-nav>
            <div class="avatar" style="background:${esc(u.color)}">${esc(initial(u.name))}</div><div>${esc(u.name)}${u.kid ? ' <span class="badge">kid</span>' : ''}</div></button>`).join('')}
        <button class="profile add" id="addUser" data-nav><div class="avatar">+</div><div>Add player</div></button>
      </div>
      <p class="hint">Right-click or press and hold a player to change them.
      ${sync ? (backend.sync.connected() ? 'Family saves on.' : `<button class="link" id="connect" data-nav>Connect family saves</button>`) : ''}</p>`;
    app.querySelectorAll('.profile[data-id]').forEach(b => {
      b.onclick = () => { ls.set('arcade.user', b.dataset.id); location.hash = 'lib'; };
      longPress(b, () => editUser(users.find(u => u.id === b.dataset.id)));
    });
    $('addUser').onclick = () => editUser(null);
    const c = $('connect'); if (c) c.onclick = openSync;
    ArcadeNav.focusFirst();
  }

  // Right-click on a computer, press-and-hold on a phone, Y on a controller.
  function longPress(el, fn) {
    el.oncontextmenu = e => { e.preventDefault(); fn(); };
    let t; el.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') t = setTimeout(() => { t = null; fn(); }, 550); });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, () => clearTimeout(t));
    el.dataset.options = '1';
  }

  const dlg = $('userDlg');
  let editing = null, pickedColor = COLORS[0];
  function editUser(u) {
    editing = u; pickedColor = u ? u.color : COLORS[users.length % COLORS.length];
    $('userDlgTitle').textContent = u ? 'Edit player' : 'New player';
    $('userName').value = u ? u.name : '';
    $('userKid').checked = !!(u && u.kid);
    $('userDelete').hidden = !u || users.length < 2;
    const c = $('userColors');
    c.innerHTML = COLORS.map(col => `<button type="button" data-c="${col}" style="background:${col}" class="${col === pickedColor ? 'on' : ''}" aria-label="colour" data-nav></button>`).join('');
    c.querySelectorAll('button').forEach(b => b.onclick = () => { pickedColor = b.dataset.c; c.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
    dlg.showModal(); $('userName').focus();
  }
  $('userCancel').onclick = () => dlg.close();
  $('userDelete').onclick = async () => { all = all.filter(x => x !== editing); await saveAll(); dlg.close(); route(); };
  $('userForm').onsubmit = async e => {
    e.preventDefault();
    const name = $('userName').value.trim(); if (!name) return;
    if (!editing) { editing = { id: idFor(name) }; all.push(editing); }
    editing.name = name; editing.color = pickedColor; editing.kid = $('userKid').checked || undefined;
    await saveAll(); dlg.close(); route();
  };

  // ---------- Family saves ----------
  const syncDlg = $('syncDlg');
  function openSync() {
    if (!backend.sync) return;
    const on = backend.sync.connected();
    $('syncCode').value = '';
    $('syncStatus').textContent = on ? 'Connected. Saves and players are shared with the family.' : 'Enter the family code to share saves between devices.';
    $('syncDisconnect').hidden = !on;
    $('syncCode').parentElement.querySelector('.btn.primary').hidden = on;
    $('syncCode').hidden = on;
    const extra = $('syncExtras'); extra.innerHTML = '';
    (backend.settingsActions || []).forEach(a => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = a.label; b.dataset.nav = '1'; b.onclick = () => a.onclick(); extra.appendChild(b); });
    syncDlg.showModal();
  }
  $('syncCancel').onclick = () => syncDlg.close();
  $('syncDisconnect').onclick = async () => { await backend.sync.disconnect(); syncDlg.close(); toast('Family saves disconnected.'); route(); };
  $('syncForm').onsubmit = async e => {
    e.preventDefault();
    const code = $('syncCode').value.trim();
    if (code.length < 8) { $('syncStatus').textContent = 'The family code needs at least 8 characters.'; return; }
    $('syncStatus').textContent = 'Connecting...';
    const r = await backend.sync.connect(code);
    if (!r.ok) { $('syncStatus').textContent = r.error || 'Could not connect. Check the internet connection and the code.'; return; }
    syncDlg.close(); toast('Family saves connected.'); route();
  };

  // ---------- Library ----------
  async function renderLibrary(sys) {
    const user = me(); const kid = !!user.kid;
    library = await backend.games();
    recent = (await backend.recent(user.id)).sort((a, b) => b.at - a.at);
    const hidden = new Set(kid ? settings().hiddenForKids || [] : []);
    const favs = new Set(user.favs || []);
    const play = user.play || {};
    const visibleLib = library.filter(g => !hidden.has(g.id) && !/\(Disc [2-9]\)/.test(g.title));
    const present = Object.keys(SYSTEMS).filter(s => visibleLib.some(g => g.system === s));
    const lastAt = Object.fromEntries(recent.map(r => [r.id, r.at]));
    let shown = visibleLib.filter(g => (!sys || g.system === sys) && (!query || nice(g.title).toLowerCase().includes(query)));
    if (sort === 'recent') shown.sort((a, b) => (lastAt[b.id] || 0) - (lastAt[a.id] || 0) || sortKey(a).localeCompare(sortKey(b)));
    else if (sort === 'system') shown.sort((a, b) => SYSTEMS[a.system].localeCompare(SYSTEMS[b.system]) || sortKey(a).localeCompare(sortKey(b)));
    else shown.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const rows = !sys && !query;
    const favGames = rows ? visibleLib.filter(g => favs.has(g.id)).sort((a, b) => sortKey(a).localeCompare(sortKey(b))) : [];
    const recentGames = rows ? recent.map(r => visibleLib.find(g => g.id === r.id)).filter(Boolean).slice(0, 6) : [];
    const sync = backend.sync && backend.sync.available;
    const usage = backend.usage ? await backend.usage() : '';

    const card = g => {
      const at = lastAt[g.id], mins = play[g.id] || 0;
      const isNew = g.added && Date.now() - g.added < NEW_DAYS * 864e5 && !at;
      const sub = at ? 'Played ' + new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + (fmtTime(mins) ? ' · ' + fmtTime(mins) : '')
        : SYSTEMS[g.system] + (g.native ? ' · ' + NATIVE[g.system] : '');
      return `<button class="card" data-id="${esc(g.id)}" data-nav>
        <div class="cover">${g.cover ? `<img src="${esc(g.cover)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:${esc(JSON.stringify(nice(g.title)))}}))">` : `<div class="ph">${esc(nice(g.title))}</div>`}
          ${favs.has(g.id) ? '<span class="star">★</span>' : ''}${isNew ? '<span class="new">NEW</span>' : ''}</div>
        <div class="meta"><div class="t">${esc(nice(g.title))}</div><div class="s">${at ? '<span class="dot"></span> ' : ''}${esc(sub)}</div></div>
      </button>`;
    };

    app.innerHTML = `
      <header class="top">
        <h1>Retro <span>Arcade</span></h1>
        <div class="spacer"></div>
        ${sync && !kid ? `<button class="btn icon" id="gear" title="Family saves" data-nav>${backend.sync.connected() ? '☁' : '☁̸'}</button>` : ''}
        <button class="chip" id="switch" title="Switch player" data-nav>
          <div class="avatar" style="background:${esc(user.color)}">${esc(initial(user.name))}</div>${esc(user.name)}
        </button>
      </header>
      <div class="bar">
        <input class="search" id="q" type="search" placeholder="Search games" value="${esc(query)}" data-nav>
        ${kid ? '' : `<select class="sel" id="sort" title="Sort" data-nav>
          <option value="az" ${sort === 'az' ? 'selected' : ''}>A to Z</option>
          <option value="recent" ${sort === 'recent' ? 'selected' : ''}>Recently played</option>
          <option value="system" ${sort === 'system' ? 'selected' : ''}>By system</option></select>`}
        ${kid ? '' : (backend.extras || []).map((x, i) => `<button class="btn primary" data-extra="${i}" data-nav>${esc(x.label)}</button>`).join('')}
      </div>
      ${visibleLib.length ? `<nav class="tabs">
        <button class="tab ${!sys ? 'on' : ''}" data-s="" data-nav>All</button>
        ${present.map(s => `<button class="tab ${sys === s ? 'on' : ''}" data-s="${s}" data-nav>${SYSTEMS[s]}</button>`).join('')}
      </nav>` : ''}
      ${favGames.length ? `<h3 class="row">Favourites</h3><div class="grid">${favGames.map(card).join('')}</div>` : ''}
      ${recentGames.length ? `<h3 class="row">Continue playing</h3><div class="grid">${recentGames.map(card).join('')}</div>` : ''}
      ${visibleLib.length ? `<h3 class="row">${sys ? SYSTEMS[sys] : 'All games'} <span class="badge">${shown.length}</span></h3>
        <div class="grid">${shown.map(card).join('')}</div>
        <p class="hint">${kid ? '' : 'Right-click or press and hold a game for favourites and more. '}${esc(usage)}</p>`
      : `<div class="empty"><p>${backend.extras ? 'No games on this phone yet. Tap <b>+ Add games</b> and pick game files from your phone\'s storage.' : 'No games found. Add game files to the games folder.'}</p></div>`}`;

    app.querySelectorAll('.tab').forEach(t => t.onclick = () => { location.hash = 'lib' + (t.dataset.s ? '/' + t.dataset.s : ''); });
    app.querySelectorAll('.card').forEach(c => {
      const g = library.find(x => x.id === c.dataset.id);
      c.onclick = () => { if (g.native) toast(`Opening ${nice(g.title)} in ${NATIVE[g.system]}...`, 6000); backend.play(g, user); };
      if (!kid) longPress(c, () => gameOptions(g, user));
    });
    $('switch').onclick = () => { location.hash = ''; };
    const gear = $('gear'); if (gear) gear.onclick = openSync;
    const sortSel = $('sort'); if (sortSel) sortSel.onchange = () => { sort = sortSel.value; ls.set('arcade.sort', sort); renderLibrary(sys); };
    app.querySelectorAll('[data-extra]').forEach(b => b.onclick = () => backend.extras[+b.dataset.extra].onclick());
    const q = $('q');
    q.oninput = () => { query = q.value.trim().toLowerCase(); renderLibrary(sys).then(() => { const n = $('q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); };
    if (document.body.classList.contains('gp')) ArcadeNav.focusFirst();
  }

  // Long-press / right-click menu for a game.
  const pop = $('popDlg');
  function gameOptions(g, user) {
    const favs = new Set(user.favs || []), hid = new Set(settings().hiddenForKids || []);
    const items = [
      { label: favs.has(g.id) ? '☆ Remove from favourites' : '★ Add to favourites', fn: async () => { favs.has(g.id) ? favs.delete(g.id) : favs.add(g.id); user.favs = [...favs]; await saveAll(); } },
      { label: hid.has(g.id) ? 'Show to kid profiles' : 'Hide from kid profiles', fn: async () => { hid.has(g.id) ? hid.delete(g.id) : hid.add(g.id); settings().hiddenForKids = [...hid]; await saveAll(); } },
      ...((backend.gameActions && backend.gameActions(g, user)) || []).map(a => ({ label: a.label, fn: a.onclick })),
    ];
    $('popTitle').textContent = nice(g.title);
    $('popList').innerHTML = items.map((it, i) => `<button type="button" class="hist" data-i="${i}" data-nav>${esc(it.label)}</button>`).join('');
    $('popList').querySelectorAll('button').forEach(b => b.onclick = async () => { pop.close(); await items[+b.dataset.i].fn(); route(); });
    pop.showModal(); ArcadeNav.focusFirst();
  }
  $('popCancel').onclick = () => pop.close();

  ArcadeNav.configure({
    enabled: () => true,
    onBack: () => { if (location.hash.startsWith('#lib/')) location.hash = 'lib'; else if (location.hash === '#lib') location.hash = ''; },
    onOptions: el => { if (el && el.dataset.options) el.dispatchEvent(new Event('contextmenu', { cancelable: true })); },
  });
  window.addEventListener('hashchange', route);
  return { route, toast, reload: route };
};
