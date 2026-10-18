// In-game player shared by the computer arcade and the phone app.
// The page gives it a backend (where saves live) and this handles the rest:
//   - instant save the moment the game saves (checked every 2 seconds)
//   - a full snapshot every 30 seconds, when the app is hidden, and on the way back to the menu
//   - "Go back" to an earlier snapshot (local history + family store history)
//   - DS extras: Stylus mode (hides on-screen buttons) and Swap screens
window.ArcadePlayer = function (backend) {
  const { game } = backend;
  const $ = id => document.getElementById(id);
  let ready = false, busy = false, lastSramHash = null, started = false;

  const setStatus = t => { $('status').textContent = t; };
  function toast(msg, actLabel, act, ms = 7000) {
    const t = $('toast'), b = $('toastAct');
    $('toastMsg').textContent = msg;
    b.hidden = !actLabel; b.textContent = actLabel || '';
    b.onclick = () => { t.classList.remove('show'); act && act(); };
    t.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), ms);
  }
  const ago = at => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : new Date(at).toLocaleDateString(); };
  function hash(b) { let h = 2166136261; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619); } return h >>> 0; }
  const gm = () => window.EJS_emulator.gameManager;

  async function restore() {
    started = true;
    try {
      const sram = await backend.getSave('sram');
      if (sram) {
        const p = gm().getSaveFilePath(), dir = p.substring(0, p.lastIndexOf('/'));
        try { gm().FS.mkdirTree ? gm().FS.mkdirTree(dir) : gm().FS.mkdir(dir); } catch {}
        try { gm().FS.unlink(p); } catch {}
        gm().FS.writeFile(p, sram.bytes);
        gm().loadSaveFiles();
        lastSramHash = hash(sram.bytes);
      }
      const state = gm().supportsStates() ? await backend.getSave('state') : null;
      if (state) {
        gm().loadState(state.bytes);
        toast('Picked up where you left off' + (state.fromCloud ? ' (from another device).' : '.'), 'Start from the title screen instead', () => gm().restart());
      }
    } catch (e) { console.warn('restore failed', e); }
    ready = true;
    setStatus('Auto-save on');
  }

  // The game wrote its own save (in-game Save menu): keep it right away.
  async function checkSram() {
    if (!ready || busy) return;
    try {
      const sram = gm().getSaveFile();
      if (!sram || !sram.length) return;
      const h = hash(sram);
      if (h === lastSramHash) return;
      lastSramHash = h; busy = true;
      await backend.putSave('sram', sram.slice(), Date.now());
      setStatus('Game saved ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    } catch (e) { console.warn('sram save failed', e); }
    busy = false;
  }
  async function snapshot() {
    if (!ready || busy) return;
    busy = true;
    try {
      const sram = gm().getSaveFile();
      if (sram && sram.length) { lastSramHash = hash(sram); await backend.putSave('sram', sram.slice(), Date.now()); }
      if (gm().supportsStates()) await backend.putSave('state', gm().getState().slice(), Date.now());
      setStatus('Saved ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    } catch (e) { console.warn('snapshot failed', e); setStatus('Save failed, will retry'); }
    busy = false;
  }
  async function exitToMenu() { setStatus('Saving...'); await snapshot(); location.replace(backend.menuUrl); }

  async function goBack() {
    let list;
    try { list = await backend.history(); } catch { list = []; }
    const dlg = $('historyDlg'), box = $('historyList');
    box.innerHTML = list.length ? list.map(h => `<button class="hist" data-id="${h.id}">${h.label} <small>${ago(h.at)}</small></button>`).join('')
      : '<p class="hint">No earlier snapshots yet. They build up as you play.</p>';
    box.querySelectorAll('.hist').forEach(b => b.onclick = async () => {
      dlg.close();
      try { const s = await backend.historyBytes(b.dataset.id); gm().loadState(s.bytes); toast('Went back to ' + ago(s.at) + '.', null, null, 3000); }
      catch (e) { toast('Could not load that snapshot.'); }
    });
    dlg.showModal();
  }

  // ---- wire up ----
  $('exit').onclick = exitToMenu;
  $('saveNow').onclick = async () => { await snapshot(); toast('Saved.', null, null, 2500); };
  $('back').onclick = goBack;
  $('historyClose').onclick = () => $('historyDlg').close();
  setInterval(checkSram, 2000);
  setInterval(snapshot, 30000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) snapshot(); });
  window.addEventListener('pagehide', () => { if (ready) snapshot(); });
  history.pushState({ playing: true }, '');
  window.addEventListener('popstate', exitToMenu);
  // Loading watchdog: a black screen with no explanation is the worst outcome.
  setTimeout(() => { if (!started) { setStatus(''); toast('This game is taking too long to load. Check the game file, or try again online.', 'Back to menu', () => location.replace(backend.menuUrl), 0); } }, 90000);

  const isTouch = matchMedia('(pointer: coarse)').matches;
  if (game.system === 'nds') {
    window.EJS_defaultOptions = { melonds_touch_mode: isTouch ? 'Touch' : 'Mouse', melonds_screen_layout: 'Top/Bottom' };
    const stylus = $('stylus'), swap = $('swap');
    stylus.hidden = !isTouch; swap.hidden = false;
    let pad = true;
    stylus.onclick = () => { pad = !pad; window.EJS_emulator.toggleVirtualGamepad(pad); stylus.textContent = pad ? 'Stylus' : 'Buttons'; };
    let top = true;
    swap.onclick = () => { top = !top; try { window.EJS_emulator.changeSettingOption('melonds_screen_layout', top ? 'Top/Bottom' : 'Bottom/Top'); } catch (e) { console.warn(e); } };
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
