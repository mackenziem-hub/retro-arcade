// In-game player shared by the computer arcade and the phone app.
// The page gives it a backend (where saves live) and this handles the rest:
//   - instant save the moment the game saves (checked every 2 seconds)
//   - a full snapshot every 30 seconds, when the app is hidden, and on the way back to the menu,
//     but only after someone has actually played, so a game left open never re-saves old progress
//   - quick menu (Esc, the Menu button, Select+Start or Guide on a controller): manual slots, Go back, screenshot, fast forward
//   - DS extras: Swap screens, Stylus mode on phones, and a virtual stylus driven by the controller or keyboard
//   - playtime, vibration on touch buttons, landscape on phones
window.ArcadePlayer = function (backend) {
  const { game } = backend;
  const $ = id => document.getElementById(id);
  const isTouch = matchMedia('(pointer: coarse)').matches;
  const isDS = game.system === 'nds';
  let ready = false, busy = false, lastSramHash = null, started = false, menuOpen = false, ff = false;
  let played = false, warnedConflict = false;   // played: input since the last snapshot
  let lastInput = 0, lastSramSent = 0;

  const setStatus = t => { $('status').textContent = t; };
  function toast(msg, actLabel, act, ms = 7000) {
    const t = $('toast'), b = $('toastAct');
    $('toastMsg').textContent = msg;
    b.hidden = !actLabel; b.textContent = actLabel || '';
    b.onclick = () => { t.classList.remove('show'); act && act(); };
    t.classList.add('show');
    clearTimeout(toast.timer); if (ms > 0) toast.timer = setTimeout(() => t.classList.remove('show'), ms);   // ms 0: stays until tapped
  }
  const ago = at => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : new Date(at).toLocaleDateString(); };
  const clock = at => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function hash(b) { let h = 2166136261; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619); } return h >>> 0; }
  const E = () => window.EJS_emulator, gm = () => E().gameManager;
  // The backend calls this when a save could not go to the family store because another device saved newer progress.
  backend.notifyConflict = device => {
    if (warnedConflict) return; warnedConflict = true;
    const from = !device ? 'another device' : /^ph-/.test(device) ? 'a phone' : device;
    toast('This game has newer progress from ' + from + '. Your play here is kept on this device and was not sent. Go back to the menu and open the game again to continue from the newest save.', 'Back to menu', () => exitToMenu(), 0);
  };

  // ---------- saving ----------
  async function restore() {
    started = true;
    // The emulator's N64 layout puts the N64 A button on the Xbox B button and N64 B on Y. Line them up by name
    // (Xbox A = A, Xbox B = B) unless someone picked their own buttons in the control settings.
    if (game.system === 'n64') try {
      for (const p of Object.values(E().controls)) {
        if (p[0] && p[0].value2 === 'BUTTON_2') p[0].value2 = 'BUTTON_1';
        if (p[1] && p[1].value2 === 'BUTTON_4') p[1].value2 = 'BUTTON_2';
      }
    } catch (e) { console.warn('n64 buttons', e); }
    if (bare) { ready = true; setStatus('bare'); return; }
    try {
      const sram = await backend.getSave('sram');
      let offline = sram && sram.cloudUnreachable;
      if (sram && sram.bytes) {
        const p = gm().getSaveFilePath(), dir = p.substring(0, p.lastIndexOf('/'));
        try { gm().FS.mkdirTree ? gm().FS.mkdirTree(dir) : gm().FS.mkdir(dir); } catch {}
        try { gm().FS.unlink(p); } catch {}
        gm().FS.writeFile(p, sram.bytes);
        gm().loadSaveFiles();
        lastSramHash = hash(sram.bytes);
      }
      const state = gm().supportsStates() ? await backend.getSave('state') : null;
      offline = offline || (state && state.cloudUnreachable);
      if (state && state.bytes) {
        gm().loadState(state.bytes);
        toast('Picked up where you left off' + (state.fromCloud ? ' (from another device).' : '.'), 'Start from the title screen instead', () => gm().restart());
      }
      if (offline) toast('Could not reach family saves, so this is the copy saved on this device. If you played on another device since, go back to the menu and try again when the internet is working.', 'Back to menu', () => exitToMenu(), 12000);
    } catch (e) { console.warn('restore failed', e); }
    ready = true;
    setStatus('Auto-save on');
    if (isDS && !bare) setupStylus();
    if (isTouch && !bare) setupTouch();
    // Browsers hold the sound (and with it the emulator) until the page has been clicked once.
    setTimeout(() => {
      let f = 0; try { f = gm().getFrameNum(); } catch {}
      if (f < 30 && !menuOpen) { const o = $('tapToPlay'); o.hidden = false; const go = e => { if (e) e.preventDefault(); o.hidden = true; try { E().elements.parent.focus(); } catch {} }; o.onpointerdown = go; o.onclick = go; }
    }, 2500);
  }
  async function checkSram() {
    if (!ready || busy) return;
    // Some games use their save memory as scratch space, so it changes even when nobody plays. Only send it while
    // someone has played in the last 2 minutes, and at most every 10 seconds.
    if (Date.now() - lastInput > 120000 || Date.now() - lastSramSent < 10000) return;
    try {
      const sram = gm().getSaveFile();
      if (!sram || !sram.length) return;
      const h = hash(sram);
      if (h === lastSramHash) return;
      lastSramHash = h; busy = true; lastSramSent = Date.now();
      await backend.putSave('sram', sram.slice(), Date.now());
      setStatus('Game saved ' + clock(Date.now()));
    } catch (e) { console.warn('sram save failed', e); }
    busy = false;
  }
  // kind 'state' with force false is the background snapshot: skipped unless someone played since the last one.
  async function snapshot(kind = 'state', force = false) {
    if (!ready || busy) return false;
    const background = kind === 'state' && !force;
    if (background && !played) return true;
    busy = true; let ok = true;
    try {
      const sram = gm().getSaveFile();
      if (sram && sram.length) { const h = hash(sram); if (h !== lastSramHash) { lastSramHash = h; await backend.putSave('sram', sram.slice(), Date.now()); } }
      if (gm().supportsStates()) await backend.putSave(kind, gm().getState().slice(), Date.now());
      if (kind === 'state') played = false;
      setStatus('Saved ' + clock(Date.now()));
    } catch (e) { console.warn('snapshot failed', e); setStatus('Save failed, will retry'); ok = false; }
    busy = false; return ok;
  }
  async function exitToMenu() { setStatus('Saving...'); await snapshot(); location.replace(backend.menuUrl); }

  // ---------- quick menu ----------
  const quick = $('quickDlg');
  function pause(on) { try { if (on && !E().paused) E().togglePlaying(); if (!on && E().paused) E().togglePlaying(); } catch {} }
  async function openQuick() {
    if (!started || menuOpen) return;
    menuOpen = true; pause(true);
    const slots = [];
    for (let i = 1; i <= 3; i++) { let s = null; try { s = await backend.peekSave('slot' + i); } catch {} slots.push(s); }
    $('quickSlots').innerHTML = slots.map((s, i) => `
      <div class="slot"><span>Slot ${i + 1}<small>${s ? 'saved ' + clock(s.at) + ', ' + ago(s.at) : 'empty'}</small></span>
        <button type="button" class="btn" data-save="${i + 1}" data-nav>Save</button>
        <button type="button" class="btn" data-load="${i + 1}" data-nav ${s ? '' : 'disabled'}>Load</button></div>`).join('');
    $('quickSlots').querySelectorAll('[data-save]').forEach(b => b.onclick = async () => { closeQuick(); if (await snapshot('slot' + b.dataset.save)) toast('Saved to slot ' + b.dataset.save + '.', null, null, 2500); });
    $('quickSlots').querySelectorAll('[data-load]').forEach(b => b.onclick = async () => { closeQuick(); try { const s = await backend.getSave('slot' + b.dataset.load); if (s) { gm().loadState(s.bytes); toast('Loaded slot ' + b.dataset.load + '.', null, null, 2500); } } catch { toast('Could not load that slot.'); } });
    $('ffBtn').textContent = 'Fast forward: ' + (ff ? 'on' : 'off');
    $('stylusBtn').textContent = 'Virtual stylus: ' + (stylus.on ? 'on' : 'off');
    quick.showModal(); ArcadeNav.focusFirst();
  }
  function closeQuick() { if (!menuOpen) return; quick.close(); menuOpen = false; pause(false); try { E().elements.parent.focus(); } catch {} }
  $('quickResume').onclick = closeQuick;
  $('quickExit').onclick = () => { closeQuick(); exitToMenu(); };
  $('quickBack').onclick = () => { quick.close(); goBack(); };
  $('ffBtn').onclick = () => { ff = !ff; try { E().changeSettingOption('fastForward', ff ? 'enabled' : 'disabled'); } catch (e) { console.warn(e); } closeQuick(); setStatus(ff ? 'Fast forward on' : 'Auto-save on'); };
  $('shotBtn').onclick = () => { closeQuick(); try { E().screenshot(blob => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = game.title.replace(/\s*\([^)]*\)/g, '') + ' ' + new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.') + '.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); toast('Screenshot saved to Downloads.', null, null, 3000); }); } catch (e) { toast('Could not take a screenshot.'); } };
  quick.addEventListener('cancel', e => { e.preventDefault(); closeQuick(); });

  async function goBack() {
    let list;
    try { list = await backend.history(); } catch { list = []; }
    const dlg = $('historyDlg'), box = $('historyList');
    box.innerHTML = list.length ? list.map(h => `<button type="button" class="hist" data-id="${h.id}" data-nav>${h.label} <small>${ago(h.at)}</small></button>`).join('')
      : '<p class="hint">No earlier snapshots yet. They build up as you play.</p>';
    box.querySelectorAll('.hist').forEach(b => b.onclick = async () => {
      dlg.close(); menuOpen = false; pause(false);
      try { const s = await backend.historyBytes(b.dataset.id); gm().loadState(s.bytes); toast('Went back to ' + ago(s.at) + '.', null, null, 3000); }
      catch (e) { toast('Could not load that snapshot.'); }
    });
    dlg.showModal(); ArcadeNav.focusFirst();
  }
  $('historyClose').onclick = () => { $('historyDlg').close(); menuOpen = false; pause(false); };

  // ---------- DS: swap, stylus mode, virtual stylus ----------
  let top = true;
  function swapScreens() { top = !top; try { E().changeSettingOption('melonds_screen_layout', top ? 'Top/Bottom' : 'Bottom/Top'); } catch (e) { console.warn(e); } }
  $('swapBtn').onclick = () => { closeQuick(); swapScreens(); };
  $('swap').onclick = swapScreens;
  let pad = true;
  $('stylus').onclick = () => { pad = !pad; E().toggleVirtualGamepad(pad); $('stylus').textContent = pad ? 'Stylus' : 'Buttons'; };

  // Virtual stylus: a cursor over the touch screen moved with the right stick or I/J/K/L,
  // tapped (or held to drag) with the right trigger or Space. It sends real pointer events to the game.
  const stylus = { on: false, x: 0.5, y: 0.5, down: false, keys: {} };
  const cursor = $('stylusCursor');
  // The canvas element fills the window; the DS picture is letterboxed inside it. Find the picture, then its touch half.
  function bottomRect() {
    const cv = E().canvas, r = cv.getBoundingClientRect();
    const aspect = (cv.width && cv.height) ? cv.width / cv.height : 256 / 384;
    let w = r.width, h = r.height;
    if (w / h > aspect) w = h * aspect; else h = w / aspect;
    const left = r.left + (r.width - w) / 2, topY = r.top + (r.height - h) / 2;
    return { left, top: top ? topY + h / 2 : topY, width: w, height: h / 2 };
  }
  window.__arcadeStylus = stylus;
  function stylusPoint() { const r = bottomRect(); return { x: r.left + stylus.x * r.width, y: r.top + stylus.y * r.height }; }
  function placeCursor() { const p = stylusPoint(); cursor.style.left = p.x + 'px'; cursor.style.top = p.y + 'px'; cursor.classList.toggle('down', stylus.down); }
  function send(type) {
    const p = stylusPoint(), c = E().canvas;
    c.dispatchEvent(new MouseEvent(type, { clientX: p.x, clientY: p.y, screenX: p.x, screenY: p.y, bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1 }));
  }
  function press(down) { if (!stylus.on || stylus.down === down) return; stylus.down = down; send(down ? 'mousedown' : 'mouseup'); placeCursor(); }
  function setStylus(on) {
    stylus.on = on; cursor.hidden = !on; $('stylusHint').hidden = !on;
    if (on) { placeCursor(); toast('Virtual stylus: move it with the right stick or I J K L, tap with the right trigger or Space.', null, null, 6000); } else press(false);
  }
  $('stylusBtn').onclick = () => { closeQuick(); setStylus(!stylus.on); };
  function setupStylus() {
    let last = performance.now();
    const KEYS = { KeyI: [0, -1], KeyK: [0, 1], KeyJ: [-1, 0], KeyL: [1, 0] };
    document.addEventListener('keydown', e => {
      if (!stylus.on || menuOpen) return;
      if (KEYS[e.code]) { stylus.keys[e.code] = true; e.stopPropagation(); e.preventDefault(); }
      else if (e.code === 'Space') { stylus.keys.Space = true; press(true); e.stopPropagation(); e.preventDefault(); }
    }, true);
    document.addEventListener('keyup', e => {
      if (!stylus.on) return;
      if (KEYS[e.code]) { stylus.keys[e.code] = false; e.stopPropagation(); }
      else if (e.code === 'Space') { stylus.keys.Space = false; press(false); e.stopPropagation(); }
    }, true);
    (function tick(now) {
      requestAnimationFrame(tick);
      if (!stylus.on || menuOpen) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      let dx = 0, dy = 0;
      for (const k in KEYS) if (stylus.keys[k]) { dx += KEYS[k][0]; dy += KEYS[k][1]; }
      let trigger = false;
      for (const gp of (navigator.getGamepads ? navigator.getGamepads() : [])) {
        if (!gp) continue;
        const ax = gp.axes || [];
        if (Math.abs(ax[2] || 0) > 0.2) dx += ax[2]; if (Math.abs(ax[3] || 0) > 0.2) dy += ax[3];
        if ((gp.buttons[7] && gp.buttons[7].pressed) || (gp.buttons[11] && gp.buttons[11].pressed)) trigger = true;
      }
      if (dx || dy) {
        stylus.x = Math.min(1, Math.max(0, stylus.x + dx * dt * 0.9 * 0.75));
        stylus.y = Math.min(1, Math.max(0, stylus.y + dy * dt * 0.9));
        placeCursor(); if (stylus.down) send('mousemove');
      }
      if (trigger !== stylus.down && (trigger || !stylus.keys.Space)) press(trigger);
    })(last);
    window.addEventListener('resize', () => stylus.on && placeCursor());
  }

  // ---------- phones ----------
  function setupTouch() {
    document.addEventListener('touchstart', e => { if (e.target.closest('[class*="ejs_virtualGamepad"], [class*="ejs_dpad"]') && navigator.vibrate) navigator.vibrate(8); }, { passive: true });
    // Go full screen in the right orientation on the first touch (browsers only allow it from a gesture).
    let done = false;
    document.addEventListener('touchend', () => {
      if (done || menuOpen) return; done = true;
      try { document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => screen.orientation.lock(isDS ? 'portrait' : 'landscape')).catch(() => {}); } catch {}
    }, { passive: true, once: false });
  }

  // ---------- playtime ----------
  setInterval(() => { if (ready && !menuOpen && !document.hidden && backend.addPlaytime) backend.addPlaytime(1).catch(() => {}); }, 60000);

  // ---------- wire up ----------
  $('menuBtn').onclick = openQuick;
  $('saveNow').onclick = async () => { if (await snapshot('state', true)) toast('Saved.', null, null, 2500); };
  // Anything the player does counts as play: keys, clicks, touches, and controller buttons or sticks.
  const input = () => { played = true; lastInput = Date.now(); };
  for (const ev of ['keydown', 'pointerdown', 'touchstart']) window.addEventListener(ev, input, { capture: true, passive: true });
  setInterval(() => {
    if (document.hidden || Date.now() - lastInput < 1000) return;
    try { for (const p of navigator.getGamepads ? navigator.getGamepads() : []) if (p && (p.buttons.some(b => b.pressed) || p.axes.some(a => Math.abs(a) > 0.5))) { input(); break; } } catch {}
  }, 250);
  const bare = new URLSearchParams(location.search).has('bare');   // troubleshooting: no timers, no extras
  if (!bare) setInterval(checkSram, 2000);
  if (!bare) setInterval(() => { if (!menuOpen) snapshot(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) snapshot(); });
  window.addEventListener('pagehide', () => { if (ready) snapshot(); });
  history.pushState({ playing: true }, '');
  window.addEventListener('popstate', exitToMenu);
  ArcadeNav.configure({ enabled: () => menuOpen, onBack: closeQuick, onMenu: () => menuOpen ? closeQuick() : openQuick() });
  setTimeout(() => { if (!started) { setStatus(''); toast('This game is taking too long to load. Check the game file, or try again online.', 'Back to menu', () => location.replace(backend.menuUrl), 0); } }, 90000);

  if (isDS) {
    if (!new URLSearchParams(location.search).has('nodef')) window.EJS_defaultOptions = { melonds_touch_mode: 'Touch', melonds_screen_layout: 'Top/Bottom' };
    $('stylus').hidden = !isTouch; $('swap').hidden = false; $('swapBtn').hidden = false; $('stylusBtn').hidden = false;
    if (!isTouch) $('dsHint').hidden = false;
  }

  document.title = game.title.replace(/\s*\([^)]*\)/g, '') + ' - Retro Arcade';
  window.EJS_player = '#game';
  window.EJS_core = game.system;
  window.EJS_gameUrl = backend.gameUrl;
  window.EJS_gameName = game.title;
  window.EJS_pathtodata = backend.dataPath;
  window.EJS_startOnLoaded = true;
  window.EJS_disableDatabases = true;
  window.EJS_color = '#ff5d8f';
  window.EJS_backgroundColor = '#000000';
  if (backend.biosUrl) window.EJS_biosUrl = backend.biosUrl;
  if (backend.threads) window.EJS_threads = true;
  window.EJS_onGameStart = restore;
  const s = document.createElement('script');
  s.src = backend.dataPath + 'loader.js';
  s.onerror = () => toast('The emulator could not be downloaded. Connect to the internet once for this system, then try again.', 'Back to menu', () => location.replace(backend.menuUrl), 0);
  document.body.appendChild(s);
};
