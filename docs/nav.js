// Controller and keyboard navigation for the arcade pages.
// D-pad / left stick / arrow keys move between [data-nav] elements, A / Enter activates,
// B / Escape goes back one step. Select+Start (or Escape in a game) opens the quick menu.
window.ArcadeNav = (() => {
  const cfg = { enabled: () => true, onBack: () => {}, onMenu: null, onOptions: null };
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled; };
  const scope = () => document.querySelector('dialog[open]') || document;
  const items = () => [...scope().querySelectorAll('[data-nav]')].filter(visible);

  function focusFirst() { const l = items(); if (l.length && !l.includes(document.activeElement)) l[0].focus({ preventScroll: false }); }
  function move(dir) {
    const list = items(); if (!list.length) return;
    const cur = document.activeElement;
    if (!list.includes(cur)) { list[0].focus(); return; }
    const r = cur.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of list) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
      const dx = x - cx, dy = y - cy;
      let along, across;
      if (dir === 'left') { along = -dx; across = Math.abs(dy); } else if (dir === 'right') { along = dx; across = Math.abs(dy); }
      else if (dir === 'up') { along = -dy; across = Math.abs(dx); } else { along = dy; across = Math.abs(dx); }
      if (along <= 4) continue;
      const score = along + across * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) { document.body.classList.add('gp'); best.focus(); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }
  function activate() { const el = document.activeElement; if (el && el.matches('[data-nav]')) el.click(); }
  function back() {
    const d = document.querySelector('dialog[open]');
    if (d) { const c = d.querySelector('[data-cancel]'); c ? c.click() : d.close(); return; }
    cfg.onBack();
  }

  // Gamepads: edge-detect buttons, auto-repeat the d-pad while held.
  const prev = {}, held = {};
  function poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const now = performance.now();
    for (const gp of pads) {
      if (!gp) continue;
      const b = i => !!(gp.buttons[i] && gp.buttons[i].pressed);
      const ax = gp.axes || [];
      const st = { up: b(12) || ax[1] < -0.5, down: b(13) || ax[1] > 0.5, left: b(14) || ax[0] < -0.5, right: b(15) || ax[0] > 0.5,
                   a: b(0), bb: b(1), y: b(3), x: b(2), select: b(8), start: b(9), guide: b(16) };
      const p = prev[gp.index] || {}; const h = held[gp.index] || (held[gp.index] = {});
      const rose = k => st[k] && !p[k];
      if (cfg.onMenu && ((st.select && st.start && !(p.select && p.start)) || rose('guide'))) cfg.onMenu();
      if (cfg.enabled()) {
        for (const d of ['up', 'down', 'left', 'right']) {
          if (st[d]) { if (!p[d]) { move(d); h[d] = now + 400; } else if (now > h[d]) { move(d); h[d] = now + 130; } }
        }
        if (rose('a')) activate();
        if (rose('bb')) back();
        if (rose('y') && cfg.onOptions) cfg.onOptions(document.activeElement);
      }
      prev[gp.index] = st;
    }
    requestAnimationFrame(poll);
  }
  requestAnimationFrame(poll);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && cfg.onMenu && !document.querySelector('dialog[open]')) { e.preventDefault(); cfg.onMenu(); return; }
    if (!cfg.enabled()) return;
    const typing = !!(e.target && e.target.matches && e.target.matches('input, textarea, select'));
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (map[e.key] && !(typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) { e.preventDefault(); move(map[e.key]); }
    else if (e.key === 'Escape' || (e.key === 'Backspace' && !typing)) { e.preventDefault(); back(); }
  });
  document.addEventListener('mousedown', () => document.body.classList.remove('gp'));
  document.addEventListener('touchstart', () => document.body.classList.remove('gp'), { passive: true });

  return { configure: c => Object.assign(cfg, c), focusFirst, move, back };
})();
