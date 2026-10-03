/* LAUNCHBENCH trial-runs theatre: plays every method's simulation in turn.
   Pre-launch scene (the launcher at work) → the computed flight (time-compressed) → the result. */
(function () {
  'use strict';
  const X = window.__LAUNCHBENCH, LB = window.LB;
  if (!X || !LB) return;
  const { F, h, METHOD, DASH, nf } = X;
  const $ = s => document.querySelector(s);
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const ease = x => x * x * (3 - 2 * x);

  // wall-clock seconds per stage at 1×
  const DUR = { pre: 3.4, fly: 11, hold: 2.8, fail: 3.6 };
  const KIND = {
    expendable: 'pad', reusable: 'pad', fullreuse: 'pad', laser: 'laser', airlaunch: 'air', rockoon: 'balloon',
    coilgun: 'coil', startram: 'tube', railgun: 'rail', lgg: 'gas', spin: 'spin', rotovator: 'tether', elevator: 'ribbon',
  };
  const PRE_LABEL = {
    pad: 'Countdown on the pad', laser: 'Beam director locks on', air: 'Carrier jet at the drop point', balloon: 'Balloon ascent',
    coil: 'Coil track fires', tube: 'Maglev tunnel run', rail: 'Rails energised', gas: 'Gas charge ignites',
    spin: 'Spin-up in the vacuum chamber', tether: 'Pad, with the tether swinging overhead', ribbon: 'Climber clamps onto the ribbon',
  };

  const T = { order: [], i: 0, stage: 'pre', u: 0, playing: false, speed: 1, timer: null, last: 0, visible: true, evIdx: 0, preLogged: false, flashes: [], log: [], status: {}, finished: false };
  const cur = () => (X.R.byId ? X.R.byId[T.order[T.i]] : null);

  // ───────────── time mapping: slow near the start, faster later ─────────────
  function span(r) { const tr = r.traj; return [tr[0].t, tr[tr.length - 1].t]; }
  function kOf(Tt) { return Tt < 90 ? 0.4 : Math.min(5.5, Math.log(Tt / 12)); }
  function simTime(r, u) {
    const [t0, t1] = span(r), Tt = Math.max(1e-6, t1 - t0), k = kOf(Tt);
    return t0 + Tt * (Math.exp(k * u) - 1) / (Math.exp(k) - 1);
  }
  function warp(r, u) {
    const [t0, t1] = span(r), Tt = Math.max(1e-6, t1 - t0), k = kOf(Tt);
    return Tt * k * Math.exp(k * u) / (Math.exp(k) - 1) / DUR.fly;
  }
  function at(tr, t) {
    if (t <= tr[0].t) return Object.assign({ idx: 0 }, tr[0]);
    let lo = 0, hi = tr.length - 1;
    if (t >= tr[hi].t) return Object.assign({ idx: hi }, tr[hi]);
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr[mid].t <= t) lo = mid; else hi = mid; }
    const a = tr[lo], b = tr[hi], w = (t - a.t) / Math.max(1e-9, b.t - a.t);
    const o = { ph: a.ph, phase: a.phase, idx: lo };
    for (const k of ['t', 'alt', 'dr', 'v', 'vrel', 'g', 'q', 'm', 'x', 'y']) o[k] = a[k] + (b[k] - a[k]) * w;
    return o;
  }
  const burning = p => p.ph === 1 || p.ph === 2;

  // ───────────── control ─────────────
  function onResults() {
    T.order = LB.METHODS.filter(m => X.S.enabled[m.id]).map(m => m.id);
    T.status = {}; T.finished = false;
    goto(0);
    if (reduce.matches) { T.stage = 'hold'; T.u = 1; pause(); draw(); updateSide(); }
    else play();
  }
  function goto(i) {
    T.i = clamp(i, 0, Math.max(0, T.order.length - 1));
    T.stage = 'pre'; T.u = 0; T.evIdx = 0; T.preLogged = false; T.flashes = []; T.log = []; T.finished = false;
    buildStrip(); updateSide(); draw();
  }
  function play() {
    if (T.finished) { T.status = {}; goto(0); }
    T.playing = true; T.last = performance.now();
    if (!T.timer) T.timer = setInterval(tick, 33); // setInterval, not rAF: keeps running in hidden or zero-size previews
    $('#thPlay').textContent = 'Pause';
  }
  function pause() {
    T.playing = false;
    if (T.timer) clearInterval(T.timer);
    T.timer = null;
    $('#thPlay').textContent = T.finished ? 'Replay all' : 'Play';
  }
  function tick() {
    const now = performance.now();
    let dt = (now - T.last) / 1000;
    T.last = now;
    if (dt > 0.25) dt = 0.25;
    if (T.playing && T.visible && !document.hidden) advance(dt * T.speed);
    draw(); updateSide();
  }
  function advance(d) {
    const r = cur();
    if (!r) return;
    const dur = T.stage === 'pre' ? DUR.pre : T.stage === 'fly' ? DUR.fly : (r.feasible ? DUR.hold : DUR.fail);
    T.u += d / dur;
    if (T.stage === 'pre' && !T.preLogged && T.u > 0.15) { logPreEvents(r); T.preLogged = true; }
    if (T.stage === 'fly') processEvents(r, Math.min(1, T.u));
    if (T.u < 1) return;
    if (T.stage === 'pre') {
      if (r.feasible) { T.stage = 'fly'; T.u = 0; }
      else { T.stage = 'hold'; T.u = 0; T.status[r.id] = 'failed'; T.log.push({ t: null, text: 'Not viable: ' + failText(r) }); buildStrip(); }
    } else if (T.stage === 'fly') {
      processEvents(r, 1);
      // burns after the recorded flight (circularization, kick, departure) go straight into the log
      const evs = (r.events || []).slice().sort((a, b) => a.t - b.t);
      while (T.evIdx < evs.length) { const e = evs[T.evIdx++]; T.log.push({ t: e.t, text: e.label }); }
      T.stage = 'hold'; T.u = 0; T.status[r.id] = 'done'; buildStrip();
    } else if (T.i < T.order.length - 1) {
      goto(T.i + 1);
    } else {
      T.u = 1; T.finished = true; pause(); buildStrip();
    }
  }
  function logPreEvents(r) {
    if (!r.traj || !r.traj.length) return;
    const t0 = r.traj[0].t;
    const evs = (r.events || []).slice().sort((a, b) => a.t - b.t);
    while (T.evIdx < evs.length && evs[T.evIdx].t < t0 - 1e-6) { T.log.push({ t: evs[T.evIdx].t, text: evs[T.evIdx].label }); T.evIdx++; }
  }
  function processEvents(r, u) {
    const t = simTime(r, u);
    const evs = (r.events || []).slice().sort((a, b) => a.t - b.t);
    while (T.evIdx < evs.length && evs[T.evIdx].t <= t + 1e-6) {
      const e = evs[T.evIdx++];
      T.log.push({ t: e.t, text: e.label });
      T.flashes.push({ text: e.label, born: performance.now() });
    }
  }
  function failText(r) { const f = r.issues.find(i => i.level === 'fail'); return f ? f.text : 'failed'; }

  // ───────────── side panel ─────────────
  function buildStrip() {
    const box = $('#thStrip');
    box.textContent = '';
    T.order.forEach((id, i) => {
      const st = i === T.i && !T.finished ? 'cur' : T.status[id] === 'done' ? 'done' : T.status[id] === 'failed' ? 'failed' : '';
      const mk = st === 'cur' ? '▶' : st === 'done' ? '✓' : st === 'failed' ? '✗' : '·';
      const b = h('button', { type: 'button', class: 'th-chip ' + st, 'aria-current': st === 'cur' ? 'true' : null, title: METHOD[id].name },
        h('span', { class: 'mk', text: mk }), h('span', { class: 'sw ' + METHOD[id].family }), METHOD[id].short);
      b.addEventListener('click', () => { goto(i); play(); });
      box.append(b);
    });
  }
  let lastLogLen = -1;
  function updateSide() {
    const r = cur();
    const name = $('#thName');
    if (!r) { name.textContent = ''; return; }
    name.textContent = '';
    name.append(h('span', { class: 'sw ' + r.family }), `${T.i + 1}/${T.order.length} · ${METHOD[r.id].short}`);
    const kind = KIND[r.id];
    let stage, p = null, g = 0;
    if (T.stage === 'pre') {
      stage = PRE_LABEL[kind] + '.';
      g = preLoad(r, T.u);
    } else if (!r.feasible) {
      stage = 'Not viable: ' + failText(r);
    } else {
      const u = T.stage === 'fly' ? Math.min(1, T.u) : 1;
      p = at(r.traj, simTime(r, u));
      g = p.g || 0;
      const last = T.log.length ? T.log[T.log.length - 1].text : '';
      stage = T.stage === 'hold' ? 'Result: ' + resultLine(r) : (p.phase || '') + (last ? ' · ' + last : '');
    }
    $('#thStage').textContent = stage;
    const u = T.stage === 'fly' ? Math.min(1, T.u) : 1;
    $('#thT').textContent = p ? F.clock(p.t) : 'T− ' + Math.max(0, Math.ceil(10 * (1 - T.u))) + ' s';
    $('#thWarp').textContent = p && T.stage === 'fly' ? '×' + nf(Math.max(1, warp(r, u))) : '–';
    $('#thAlt').textContent = p ? F.km(p.alt) : '–';
    $('#thV').textContent = p ? F.speed(p.v) : '–';
    $('#thQ').textContent = p ? (p.q > 1 ? X.sig(p.q / 1000, 3) + ' kPa' : '0 kPa') : '–';
    $('#thM').textContent = p && p.m ? F.mass(p.m) : '–';
    const lim = X.R.ctx ? X.R.ctx.payload.gTol : 1;
    $('#thG').textContent = F.g(g);
    const pos = v => clamp(Math.log10(Math.max(1, v)) / 4, 0, 1) * 100;
    const bar = $('#thGBar');
    bar.style.width = pos(g) + '%';
    bar.classList.toggle('over', g > lim * 1.02);
    $('#thGLim').style.left = `calc(${pos(lim)}% - 1px)`;
    if (T.log.length !== lastLogLen) {
      lastLogLen = T.log.length;
      const ol = $('#thLog');
      ol.textContent = '';
      T.log.forEach((e, i) => ol.append(h('li', { class: i === T.log.length - 1 ? 'new' : null }, h('time', { text: e.t == null ? '' : F.clock(e.t) }), h('span', { text: e.text }))));
      ol.scrollTop = ol.scrollHeight;
    }
  }
  function preLoad(r, v) {
    const x = r.extra || {};
    const kind = KIND[r.id];
    if (['coil', 'tube', 'rail', 'gas'].includes(kind)) {
      if (!r.feasible) return 0;
      return v > 0.1 && v < 0.8 ? x.gLaunch || 0 : v >= 0.8 && v < 0.86 ? (r.peakG || 0) : 1;
    }
    if (kind === 'spin') { if (!r.feasible) return 0; const s = Math.min(1, v / 0.85); return Math.max(1, (x.gLaunch || 0) * s * s); }
    return 1;
  }
  function resultLine(r) {
    const D = X.R.ctx.D;
    return `reached ${D.short} · η ${F.pct(r.etaOverall)} · ${F.mass(r.launchMass)} launched · ${F.money(r.costPerKg)}/kg`;
  }

  // ───────────── drawing primitives ─────────────
  function flame(g, x, y, len, wid, ang) {
    g.save(); g.translate(x, y); g.rotate(ang);
    const L = len * (0.82 + Math.random() * 0.3);
    const gr = g.createLinearGradient(0, 0, L, 0);
    gr.addColorStop(0, 'rgba(255,244,214,0.95)'); gr.addColorStop(0.35, 'rgba(255,170,60,0.9)'); gr.addColorStop(1, 'rgba(255,90,20,0)');
    g.fillStyle = gr;
    g.beginPath(); g.moveTo(0, -wid / 2); g.quadraticCurveTo(L * 0.45, -wid * 0.7, L, 0); g.quadraticCurveTo(L * 0.45, wid * 0.7, 0, wid / 2); g.closePath(); g.fill();
    g.restore();
  }
  // vertical rocket for the scenes; base at (cx, by)
  function rocket(g, cx, by, hgt, col, noFins) {
    const w = Math.max(6, hgt * 0.13), body = hgt * 0.8;
    g.fillStyle = css('--panel-2'); g.strokeStyle = css('--ink'); g.lineWidth = 1.2;
    g.beginPath(); g.rect(cx - w / 2, by - body, w, body); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(cx - w / 2, by - body); g.quadraticCurveTo(cx - w / 2, by - hgt * 0.92, cx, by - hgt); g.quadraticCurveTo(cx + w / 2, by - hgt * 0.92, cx + w / 2, by - body); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = col; g.fillRect(cx - w / 2 + 1, by - body * 0.62, w - 2, body * 0.1);
    g.fillRect(cx - w / 2 + 1, by - body * 0.18, w - 2, body * 0.05);
    if (!noFins) {
      g.fillStyle = css('--ink');
      g.beginPath(); g.moveTo(cx - w / 2, by - body * 0.16); g.lineTo(cx - w * 1.05, by); g.lineTo(cx - w / 2, by); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(cx + w / 2, by - body * 0.16); g.lineTo(cx + w * 1.05, by); g.lineTo(cx + w / 2, by); g.closePath(); g.fill();
    }
  }
  // small craft for the flight view, pointing along angle ang (screen radians)
  function craft(g, x, y, ang, col, size, burn) {
    g.save(); g.translate(x, y); g.rotate(ang);
    if (burn) flame(g, -size * 0.55, 0, size * 1.6, size * 0.42, Math.PI);
    const L = size, w = size * 0.3;
    g.fillStyle = css('--panel'); g.strokeStyle = css('--ink'); g.lineWidth = 1.3;
    g.beginPath(); g.moveTo(-L / 2, -w / 2); g.lineTo(L * 0.2, -w / 2); g.quadraticCurveTo(L * 0.45, -w / 2, L / 2, 0); g.quadraticCurveTo(L * 0.45, w / 2, L * 0.2, w / 2); g.lineTo(-L / 2, w / 2); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = col; g.fillRect(-L * 0.2, -w / 2 + 1, L * 0.16, w - 2);
    g.restore();
  }
  function projectile(g, x, y, ang, col, size) {
    g.save(); g.translate(x, y); g.rotate(ang);
    g.fillStyle = css('--panel'); g.strokeStyle = css('--ink'); g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(-size / 2, -size * 0.16); g.lineTo(size * 0.15, -size * 0.16); g.lineTo(size / 2, 0); g.lineTo(size * 0.15, size * 0.16); g.lineTo(-size / 2, size * 0.16); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = col; g.fillRect(-size * 0.42, -size * 0.12, size * 0.2, size * 0.24);
    g.restore();
  }
  function burst(g, x, y, rad, alpha) {
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `rgba(255,246,220,${alpha})`); gr.addColorStop(0.4, `rgba(255,170,60,${alpha * 0.7})`); gr.addColorStop(1, 'rgba(255,120,40,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  function smoke(g, x, y, n, spread, alpha) {
    g.fillStyle = css('--muted');
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + i, rr = spread * (0.4 + ((i * 37) % 10) / 14);
      g.globalAlpha = alpha * (0.4 + ((i * 13) % 7) / 12);
      g.beginPath(); g.arc(x + Math.cos(a) * rr, y + Math.abs(Math.sin(a)) * rr * 0.35, spread * 0.45, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
  }
  function backdrop(g, W, H, gyFrac) {
    const gy = H * (gyFrac || 0.82);
    const sky = g.createLinearGradient(0, 0, 0, gy);
    sky.addColorStop(0, 'rgba(0,0,0,0)'); sky.addColorStop(1, css('--sky-low'));
    g.fillStyle = sky; g.fillRect(0, 0, W, gy);
    g.fillStyle = css('--earth'); g.fillRect(0, gy, W, H - gy);
    g.strokeStyle = css('--rule-strong'); g.lineWidth = 1; g.beginPath(); g.moveTo(0, gy + 0.5); g.lineTo(W, gy + 0.5); g.stroke();
    return gy;
  }
  function label(g, text, x, y, o) {
    o = o || {};
    g.font = `${o.weight || 400} ${o.size || 12}px ${css(o.font || '--font-body')}`;
    g.fillStyle = o.color || css('--ink');
    g.textAlign = o.align || 'left'; g.textBaseline = o.base || 'alphabetic';
    g.fillText(text, x, y);
  }
  function wrap(g, text, maxW) {
    const words = text.split(' '), lines = [];
    let line = '';
    for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
    if (line) lines.push(line);
    return lines;
  }
  function trackDraw(g, A, B, col, rings, sProj, glow) {
    const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    g.strokeStyle = css('--ink-2'); g.lineWidth = 2;
    g.beginPath(); g.moveTo(A[0] + nx * 5, A[1] + ny * 5); g.lineTo(B[0] + nx * 5, B[1] + ny * 5); g.moveTo(A[0] - nx * 5, A[1] - ny * 5); g.lineTo(B[0] - nx * 5, B[1] - ny * 5); g.stroke();
    if (rings) {
      for (let i = 0; i <= rings; i++) {
        const s = i / rings, px = A[0] + dx * s, py = A[1] + dy * s;
        const near = Math.abs(s - sProj) < 0.07;
        g.strokeStyle = near && glow ? 'rgba(255,190,80,0.95)' : col; g.lineWidth = near && glow ? 3 : 2;
        g.beginPath(); g.moveTo(px + nx * 9, py + ny * 9); g.lineTo(px - nx * 9, py - ny * 9); g.stroke();
      }
    }
    return { ux, uy, L };
  }

  // ───────────── pre-launch scenes ─────────────
  function drawPrelude(g, W, H, r, v) {
    const kind = KIND[r.id], col = css('--fam-' + r.family), x = r.extra || {};
    let caption = '';
    if (kind === 'pad' || kind === 'laser' || kind === 'tether') {
      const gy = backdrop(g, W, H);
      const cx = W * 0.44, hgt = H * 0.42;
      const rise = v > 0.8 ? Math.pow((v - 0.8) / 0.2, 2) * H * 0.6 : 0;
      // tower
      const tx = cx + hgt * 0.13 / 2 + 16;
      g.strokeStyle = css('--ink-2'); g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(tx, gy); g.lineTo(tx, gy - hgt * 1.08); g.moveTo(tx + 12, gy); g.lineTo(tx + 12, gy - hgt * 1.08);
      for (let yy = gy; yy > gy - hgt * 1.08; yy -= 14) { g.moveTo(tx, yy); g.lineTo(tx + 12, yy - 14); }
      g.stroke();
      if (v < 0.8) { g.beginPath(); g.moveTo(tx, gy - hgt * 0.85); g.lineTo(cx + 4, gy - hgt * 0.85); g.stroke(); }
      if (kind === 'laser') {
        const dx = W * 0.8;
        g.strokeStyle = css('--ink'); g.lineWidth = 2;
        g.beginPath(); g.moveTo(dx, gy); g.lineTo(dx, gy - 26); g.stroke();
        g.beginPath(); g.arc(dx, gy - 40, 22, Math.PI * 0.85, Math.PI * 1.75); g.stroke();
        if (v > 0.55) {
          const bx = cx, byy = gy - 8 - rise;
          g.strokeStyle = col; g.globalAlpha = 0.35; g.lineWidth = 7; g.beginPath(); g.moveTo(dx - 6, gy - 48); g.lineTo(bx, byy); g.stroke();
          g.globalAlpha = 1; g.strokeStyle = 'rgba(255,248,225,0.95)'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(dx - 6, gy - 48); g.lineTo(bx, byy); g.stroke();
        }
        caption = `Ground laser array · ${x.Pbeam ? F.power(x.Pbeam) : ''} beamed into a hydrogen heat exchanger`;
      }
      if (kind === 'tether') {
        const c = [W * 0.62, H * 0.16], arm = H * 0.13, a = v * Math.PI * 1.3 - Math.PI / 2;
        g.strokeStyle = css('--ink'); g.lineWidth = 2;
        g.beginPath(); g.moveTo(c[0] - Math.cos(a) * arm, c[1] - Math.sin(a) * arm); g.lineTo(c[0] + Math.cos(a) * arm, c[1] + Math.sin(a) * arm); g.stroke();
        g.fillStyle = css('--ink'); g.beginPath(); g.arc(c[0], c[1], 4, 0, Math.PI * 2); g.fill();
        label(g, `tether at ${x.rcm ? nf((x.rcm - LB.RE) / 1000) : ''} km, not to scale`, c[0] + arm + 8, c[1] + 4, { size: 11, color: css('--muted') });
        caption = `Suborbital rocket to meet the tip at ${x.catchAlt ? nf(x.catchAlt / 1000) : ''} km, ${x.vCatch ? F.speed(x.vCatch) : ''}`;
      }
      if (v > 0.62) { smoke(g, cx, gy - 4, 12, 26 + (v - 0.62) * 140, 0.45); flame(g, cx, gy - 6 - rise, 30 + (v - 0.62) * 160, 14, Math.PI / 2); }
      rocket(g, cx, gy - 6 - rise, hgt, col, r.id === 'fullreuse');
      const cd = v < 0.8 ? 'T− ' + Math.max(1, Math.ceil((0.8 - v) / 0.8 * 10)) : 'Liftoff';
      label(g, cd, 22, 64, { size: 40, weight: 800, font: '--font-display' });
      if (!caption) caption = `Liftoff mass ${F.mass(r.launchMass)}`;
    } else if (kind === 'air') {
      const gy = backdrop(g, W, H, 0.93);
      const yP = H * 0.32, px = W * (-0.12 + 1.15 * v), rel = 0.5;
      const relX = W * (-0.12 + 1.15 * rel);
      // aircraft
      g.save(); g.translate(px, yP);
      g.fillStyle = css('--panel-2'); g.strokeStyle = css('--ink'); g.lineWidth = 1.3;
      const Lf = W * 0.24;
      g.beginPath(); g.moveTo(-Lf / 2, -6); g.lineTo(Lf * 0.38, -7); g.quadraticCurveTo(Lf / 2, -6, Lf / 2 + 6, 1); g.lineTo(-Lf / 2, 8); g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(-Lf * 0.05, 0); g.lineTo(-Lf * 0.25, 30); g.lineTo(-Lf * 0.12, 30); g.lineTo(Lf * 0.12, 0); g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(-Lf / 2, -6); g.lineTo(-Lf / 2 - 6, -26); g.lineTo(-Lf / 2 + 14, -26); g.lineTo(-Lf / 2 + 26, -6); g.closePath(); g.fill(); g.stroke();
      g.restore();
      let rx, ry, ang = 0, burn = false;
      if (v < rel) { rx = px; ry = yP + 16; }
      else if (v < 0.7) { const s = (v - rel) / (0.7 - rel); rx = relX + s * W * 0.06; ry = yP + 16 + s * s * H * 0.14; }
      else { const s = (v - 0.7) / 0.3; rx = relX + W * 0.06 + s * W * 0.35; ry = yP + 16 + H * 0.14 - s * s * H * 0.35; ang = -0.55 * Math.min(1, s * 2); burn = true; }
      craft(g, rx, ry, ang, col, W * 0.11, burn);
      label(g, '11 km · Mach 0.8', 22, 40, { size: 26, weight: 800, font: '--font-display' });
      caption = `${x.carrier ? x.carrier.name : 'Carrier aircraft'} · ${x.carrier ? F.mass(x.carrier.fuel) + ' of jet fuel per sortie' : ''}`;
    } else if (kind === 'balloon') {
      const gy = backdrop(g, W, H);
      const a = Math.min(1, v / 0.82), bx = W * 0.45, R0 = H * (0.05 + 0.08 * a), by = gy - 60 - a * H * 0.5;
      g.fillStyle = css('--panel-2'); g.strokeStyle = css('--ink-2'); g.lineWidth = 1.3;
      g.beginPath(); g.ellipse(bx, by - R0 * 1.2, R0, R0 * 1.25, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      const rTop = by + R0 * 0.2;
      if (v < 0.82) {
        g.beginPath(); g.moveTo(bx, by); g.lineTo(bx, rTop + 18); g.stroke();
        rocket(g, bx, rTop + 18 + H * 0.17, H * 0.17, col);
      } else {
        const s = (v - 0.82) / 0.18;
        const rxp = bx + s * W * 0.28, ryp = rTop + 18 + H * 0.17 - s * s * H * 0.45;
        flame(g, rxp, ryp, 26, 10, Math.PI / 2 + 0.5);
        g.save(); g.translate(rxp, ryp); g.rotate(0.5); rocket(g, 0, 0, H * 0.17, col); g.restore();
      }
      label(g, 'Altitude ' + (a * (r.params ? r.params.alt / 1000 : 30)).toFixed(1) + ' km', 22, 44, { size: 26, weight: 800, font: '--font-display' });
      caption = x.helium ? `${F.mass(x.helium)} of helium · ${F.mass(x.envelope)} envelope` : 'Zero-pressure balloon';
    } else if (kind === 'coil' || kind === 'tube' || kind === 'rail' || kind === 'gas') {
      const water = kind === 'gas';
      const gy = backdrop(g, W, H, water ? 0.78 : 0.82);
      const e = ((x.elev || 25) * Math.PI) / 180;
      let A, B, pathPts = null;
      if (water) {
        g.fillStyle = css('--sky-low'); g.fillRect(0, gy, W, H - gy);
        g.strokeStyle = css('--rule-strong');
        for (let i = 0; i < 6; i++) { g.beginPath(); for (let xx = 0; xx <= W; xx += 12) g.lineTo(xx, gy + 12 + i * 10 + Math.sin(xx / 22 + v * 9 + i) * 2); g.stroke(); }
        g.fillStyle = css('--ink-2'); g.fillRect(W * 0.06, gy - 10, W * 0.2, 14);
        A = [W * 0.12, gy - 14]; const Lb = W * 0.66; B = [A[0] + Math.cos(e) * Lb, A[1] - Math.sin(e) * Lb];
      } else if (kind === 'tube') {
        g.fillStyle = css('--rule'); g.beginPath(); g.moveTo(W * 0.5, gy); g.lineTo(W * 0.84, H * 0.3); g.lineTo(W * 1.05, gy); g.closePath(); g.fill();
        pathPts = [[W * 0.01, gy + 18], [W * 0.55, gy + 18], [W * 0.83, H * 0.32]];
        A = pathPts[1]; B = pathPts[2];
      } else {
        g.fillStyle = css('--rule'); g.beginPath(); g.moveTo(W * 0.02, gy); g.lineTo(W * 0.6, H * 0.26); g.lineTo(W * 0.98, gy); g.closePath(); g.fill();
        A = [W * 0.14, gy - 6];
        const Lt = kind === 'rail' ? W * 0.32 : W * 0.5;
        const ang = kind === 'rail' ? e : Math.atan2(gy - 6 - H * 0.28, W * 0.58 - W * 0.14);
        B = [A[0] + Math.cos(ang) * Lt, A[1] - Math.sin(ang) * Lt];
      }
      const fire = 0.8, s = clamp(v / fire, 0, 1), sp = s * s;
      let P, ux, uy;
      if (pathPts) {
        // tube: underground leg then the ramp; total length normalised
        const L1 = pathPts[1][0] - pathPts[0][0], L2 = Math.hypot(B[0] - A[0], B[1] - A[1]);
        g.strokeStyle = css('--rule-strong'); g.lineWidth = 11; g.lineJoin = 'round';
        g.beginPath(); g.moveTo(pathPts[0][0], pathPts[0][1]); g.lineTo(A[0], A[1]); g.lineTo(B[0], B[1]); g.stroke();
        g.strokeStyle = css('--panel'); g.lineWidth = 6; g.stroke();
        g.strokeStyle = col; g.lineWidth = 1.5; g.setLineDash([3, 5]); g.stroke(); g.setLineDash([]);
        const d = sp * (L1 + L2);
        ux = (B[0] - A[0]) / L2; uy = (B[1] - A[1]) / L2;
        if (d < L1) { P = [pathPts[0][0] + d, pathPts[0][1]]; ux = 1; uy = 0; } else P = [A[0] + ux * (d - L1), A[1] + uy * (d - L1)];
      } else {
        const tr = trackDraw(g, A, B, col, kind === 'coil' ? 22 : 0, sp, kind === 'coil');
        ux = tr.ux; uy = tr.uy;
        P = [A[0] + (B[0] - A[0]) * sp, A[1] + (B[1] - A[1]) * sp];
        if (kind === 'rail' && v < fire && v > 0.05) {
          g.strokeStyle = 'rgba(190,220,255,0.9)'; g.lineWidth = 1.2;
          for (let i = 0; i < 7; i++) { const a = Math.random() * Math.PI * 2, l = 6 + Math.random() * 16; g.beginPath(); g.moveTo(P[0], P[1]); g.lineTo(P[0] + Math.cos(a) * l, P[1] + Math.sin(a) * l); g.stroke(); }
          g.fillStyle = css('--ink-2');
          for (let i = 0; i < 4; i++) { g.fillRect(W * 0.04 + i * 16, H * 0.86, 12, 22); g.fillStyle = col; g.fillRect(W * 0.04 + i * 16, H * 0.86 + 22 * (1 - Math.min(1, v * 3)), 12, 22 * Math.min(1, v * 3)); g.fillStyle = css('--ink-2'); }
        }
        if (kind === 'gas' && v < fire) {
          const gr = g.createLinearGradient(A[0], A[1], P[0], P[1]);
          gr.addColorStop(0, 'rgba(255,140,50,0.15)'); gr.addColorStop(1, 'rgba(255,200,90,0.75)');
          g.strokeStyle = gr; g.lineWidth = 7; g.beginPath(); g.moveTo(A[0], A[1]); g.lineTo(P[0], P[1]); g.stroke();
          g.fillStyle = css('--ink'); g.fillRect(A[0] - 18, A[1] - 9, 22, 18);
        }
      }
      if (v >= fire) {
        const k = (v - fire) / (1 - fire);
        P = [B[0] + ux * k * W * 0.55, B[1] + uy * k * W * 0.55];
        if (k < 0.45) burst(g, B[0], B[1], 30 + k * 60, 1 - k * 2);
        if (water || kind === 'rail') smoke(g, B[0], B[1], 8, 14 + k * 50, 0.35 * (1 - k));
        g.strokeStyle = css('--ink-2'); g.globalAlpha = 0.5; g.lineWidth = 1;
        g.beginPath(); g.moveTo(P[0] - ux * 40 + uy * 10, P[1] - uy * 40 - ux * 10); g.lineTo(P[0], P[1]); g.lineTo(P[0] - ux * 40 - uy * 10, P[1] - uy * 40 + ux * 10); g.stroke(); g.globalAlpha = 1;
      }
      projectile(g, P[0], P[1], Math.atan2(uy, ux), col, 26);
      const vNow = r.feasible && x.muzzle ? x.muzzle * Math.min(1, s) : 0;
      label(g, r.feasible ? F.speed(vNow) : 'held at the g-limit', 22, 44, { size: 28, weight: 800, font: '--font-display' });
      const P2 = r.params || {};
      const lenTxt = kind === 'rail' || kind === 'gas' ? nf(P2.L || 0) + ' m' : ((P2.L || 0) / 1000).toLocaleString() + ' km';
      caption = { coil: `${lenTxt} coil track on a ${(P2.exitAlt || 0) / 1000} km mountain`, tube: `${lenTxt} evacuated maglev tunnel to a ${(P2.exitAlt || 0) / 1000} km peak`, rail: `${lenTxt} rails, armature driven by mega-amp current`, gas: `${lenTxt} floating barrel, hydrogen driven by burning gas` }[kind] + (x.gLaunch ? ` · ${nf(x.gLaunch)} g` : '');
    } else if (kind === 'spin') {
      backdrop(g, W, H);
      const C = [W * 0.4, H * 0.48], R0 = Math.min(W * 0.3, H * 0.34);
      g.fillStyle = css('--panel-2'); g.strokeStyle = css('--ink'); g.lineWidth = 3;
      g.beginPath(); g.arc(C[0], C[1], R0, 0, Math.PI * 2); g.fill(); g.stroke();
      const portA = -Math.PI / 4;
      const pA = [C[0] + Math.cos(portA) * R0, C[1] + Math.sin(portA) * R0];
      const tdir = [Math.cos(portA + Math.PI / 2), Math.sin(portA + Math.PI / 2)];
      // exit tube is tangent to the arm tip at release
      const out = [-tdir[0], -tdir[1]];
      g.lineWidth = 9; g.strokeStyle = css('--ink-2'); g.beginPath(); g.moveTo(pA[0], pA[1]); g.lineTo(pA[0] + out[0] * W * 0.2, pA[1] + out[1] * W * 0.2); g.stroke();
      const rel = 0.82, s = Math.min(1, v / rel);
      const turns = 9, th = portA + Math.PI * 2 * turns * (1 - s * s); // anticlockwise on screen: tip velocity at the port points out of the tube
      if (v < rel) {
        for (let k = 1; k <= 5; k++) { g.strokeStyle = css('--muted'); g.globalAlpha = 0.12 * s; g.lineWidth = 2; g.beginPath(); g.moveTo(C[0], C[1]); g.lineTo(C[0] + Math.cos(th + k * 0.09 * s) * R0 * 0.9, C[1] + Math.sin(th + k * 0.09 * s) * R0 * 0.9); g.stroke(); }
        g.globalAlpha = 1;
      }
      g.strokeStyle = css('--ink'); g.lineWidth = 5; g.lineCap = 'round';
      g.beginPath(); g.moveTo(C[0] - Math.cos(th) * R0 * 0.45, C[1] - Math.sin(th) * R0 * 0.45); g.lineTo(C[0] + Math.cos(th) * R0 * 0.9, C[1] + Math.sin(th) * R0 * 0.9); g.stroke(); g.lineCap = 'butt';
      g.fillStyle = css('--ink'); g.beginPath(); g.arc(C[0], C[1], 7, 0, Math.PI * 2); g.fill();
      let P, ang;
      if (v < rel) { P = [C[0] + Math.cos(th) * R0 * 0.9, C[1] + Math.sin(th) * R0 * 0.9]; ang = th - Math.PI / 2; }
      else { const k = (v - rel) / (1 - rel); const P0 = [C[0] + Math.cos(portA) * R0 * 0.9, C[1] + Math.sin(portA) * R0 * 0.9]; P = [P0[0] + out[0] * k * W * 0.6, P0[1] + out[1] * k * W * 0.6]; ang = Math.atan2(out[1], out[0]); if (k > 0.25 && k < 0.6) burst(g, pA[0] + out[0] * W * 0.2, pA[1] + out[1] * W * 0.2, 26, 0.7); }
      projectile(g, P[0], P[1], ang, col, 24);
      const vt = (x.muzzle || (r.params ? r.params.vMax : 0)) * s;
      label(g, r.feasible ? `Tip ${F.speed(vt)}` : 'Spin-up halted', 22, 44, { size: 28, weight: 800, font: '--font-display' });
      caption = `${r.params ? r.params.armR : ''} m arm in a vacuum chamber${x.gLaunch ? ` · ${nf(x.gLaunch)} g at release` : ''}`;
    } else if (kind === 'ribbon') {
      const gy = backdrop(g, W, H);
      const rx = W * 0.5;
      g.strokeStyle = css('--ink-2'); g.lineWidth = 2; g.beginPath(); g.moveTo(rx, gy); g.lineTo(rx, 0); g.stroke();
      g.fillStyle = css('--ink'); g.fillRect(rx - 40, gy - 14, 80, 14);
      const cy = gy - 50 - ease(v) * H * 0.42;
      const lx = W * 0.26;
      g.strokeStyle = css('--ink'); g.lineWidth = 2; g.beginPath(); g.moveTo(lx, gy); g.lineTo(lx, gy - 20); g.stroke();
      g.beginPath(); g.arc(lx, gy - 30, 12, Math.PI * 0.9, Math.PI * 1.9); g.stroke();
      if (v > 0.2) { g.strokeStyle = col; g.globalAlpha = 0.35; g.lineWidth = 6; g.beginPath(); g.moveTo(lx + 6, gy - 36); g.lineTo(rx - 14, cy + 26); g.stroke(); g.globalAlpha = 1; g.strokeStyle = 'rgba(255,248,225,0.95)'; g.lineWidth = 1.4; g.stroke(); }
      g.fillStyle = css('--panel-2'); g.strokeStyle = css('--ink'); g.lineWidth = 1.4;
      g.beginPath(); g.rect(rx - 16, cy - 20, 32, 44); g.fill(); g.stroke();
      g.fillStyle = col; g.fillRect(rx - 22, cy + 22, 44, 5);
      label(g, 'Climbing at ' + (r.params ? r.params.speed : 200) + ' km/h', 22, 44, { size: 26, weight: 800, font: '--font-display' });
      caption = x.taper ? `Ribbon taper ${x.taper > 1e6 ? x.taper.toExponential(1) : X.sig(x.taper, 3)}×, laser-powered climber` : 'Laser-powered climber';
    }
    if (caption) label(g, caption, 22, H - 18, { size: 12, color: css('--ink') });
  }

  // ───────────── flight view ─────────────
  function bounds(r) {
    if (r.__thB) return r.__thB;
    const D = X.R.ctx.D, tAlt = (D.rPark - LB.RE) / 1000;
    let drMin = 0, drMax = 1, altMax = tAlt;
    for (const p of r.traj) { if (p.dr < drMin) drMin = p.dr; if (p.dr > drMax) drMax = p.dr; if (p.alt > altMax) altMax = p.alt; }
    const pad = (drMax - drMin) * 0.06 + 10;
    r.__thB = { drMin: drMin - pad * 0.3, drMax: drMax + pad, altMax: altMax * 1.15, tAlt };
    return r.__thB;
  }
  function drawFlight(g, W, H, r, u) {
    if (r.id === 'elevator') return drawElevator(g, W, H, r, u);
    const b = bounds(r), col = css('--fam-' + r.family);
    const m = { l: 58, r: 18, t: 46, b: 36 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
    const Xp = d => m.l + (d - b.drMin) / (b.drMax - b.drMin) * pw, Yp = a => m.t + ph - (a / b.altMax) * ph;
    const sky = g.createLinearGradient(0, Yp(0), 0, Yp(Math.min(100, b.altMax)));
    sky.addColorStop(0, css('--sky-low')); sky.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sky; g.fillRect(m.l, Yp(Math.min(100, b.altMax)), pw, Yp(0) - Yp(Math.min(100, b.altMax)));
    // grid
    g.font = '10px ' + css('--font-data'); g.lineWidth = 1;
    const ys = niceStep(b.altMax, 5), xs = niceStep(b.drMax - b.drMin, 6);
    g.strokeStyle = css('--rule'); g.fillStyle = css('--muted'); g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let a = 0; a <= b.altMax; a += ys) { const y = Math.round(Yp(a)) + 0.5; g.beginPath(); g.moveTo(m.l, y); g.lineTo(m.l + pw, y); g.stroke(); g.fillText(nf(a), m.l - 6, y); }
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let d = Math.ceil(b.drMin / xs) * xs; d <= b.drMax; d += xs) { const x = Math.round(Xp(d)) + 0.5; g.beginPath(); g.moveTo(x, m.t); g.lineTo(x, m.t + ph); g.stroke(); g.fillText(nf(d), x, m.t + ph + 6); }
    label(g, 'Downrange (km)', m.l + pw / 2, H - 6, { size: 11, color: css('--ink-2'), align: 'center' });
    g.save(); g.translate(14, m.t + ph / 2); g.rotate(-Math.PI / 2); label(g, 'Altitude (km)', 0, 0, { size: 11, color: css('--ink-2'), align: 'center', base: 'middle' }); g.restore();
    g.strokeStyle = css('--rule-strong'); g.beginPath(); g.moveTo(m.l, Yp(0) + 0.5); g.lineTo(m.l + pw, Yp(0) + 0.5); g.stroke();
    const ref = (a, text) => {
      if (a > b.altMax) return;
      g.strokeStyle = css('--ink-2'); g.globalAlpha = 0.45; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(m.l, Math.round(Yp(a)) + 0.5); g.lineTo(m.l + pw, Math.round(Yp(a)) + 0.5); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
      label(g, text, m.l + 6, Yp(a) - 4, { size: 11, color: css('--ink-2') });
    };
    ref(100, 'Kármán line · 100 km');
    ref(b.tAlt, (X.S.mission.dest === 'LEO' ? 'Target orbit · ' : 'Parking orbit · ') + nf(b.tAlt) + ' km');
    if (r.id === 'rotovator' && r.extra && r.extra.rcm) ref((r.extra.rcm - LB.RE) / 1000, 'Tether centre of mass');
    // planned path (faint) and flown path
    const tr = r.traj, tc = simTime(r, u);
    g.strokeStyle = col; g.globalAlpha = 0.22; g.lineWidth = 1.2; g.setLineDash([3, 4]);
    T.pts = [];
    g.beginPath(); tr.forEach((p, i) => { const x = Xp(p.dr), y = Yp(p.alt); T.pts.push([x, y]); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
    g.save(); g.beginPath(); g.rect(m.l, 0, pw, m.t + ph); g.clip();
    g.strokeStyle = col; g.lineWidth = 2.6; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath();
    let last = tr[0];
    for (let i = 0; i < tr.length; i++) {
      let p = tr[i];
      if (p.t > tc) p = at(tr, tc);
      const x = Xp(p.dr), y = Yp(p.alt);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
      last = p;
      if (tr[i].t > tc) break;
    }
    g.stroke();
    const now = at(tr, tc), prev = at(tr, Math.max(tr[0].t, tc - Math.max(1, (tr[tr.length - 1].t - tr[0].t) * 0.01)));
    const vx = Xp(now.dr), vy = Yp(now.alt);
    let ang = Math.atan2(vy - Yp(prev.alt), vx - Xp(prev.dr));
    if (!isFinite(ang) || (Math.abs(vx - Xp(prev.dr)) < 0.01 && Math.abs(vy - Yp(prev.alt)) < 0.01)) ang = -Math.PI / 2;
    // laser beam from the ground station while the engine is lit
    if (r.id === 'laser' && burning(now)) {
      const sx = Xp(0), sy = Yp(0);
      g.strokeStyle = col; g.globalAlpha = 0.3; g.lineWidth = 6; g.beginPath(); g.moveTo(sx, sy); g.lineTo(vx, vy); g.stroke();
      g.globalAlpha = 1; g.strokeStyle = 'rgba(255,248,225,0.9)'; g.lineWidth = 1.2; g.stroke();
    }
    // rotating tether while the payload rides it
    if (r.id === 'rotovator' && now.phase === 'Riding the tether') {
      const sw = tr.findIndex(p => p.phase === 'Riding the tether');
      const ang0 = Math.atan2(tr[sw].y, tr[sw].x);
      const n = Math.sqrt(LB.MU / Math.pow(r.extra.rcm, 3));
      const cmAng = ang0 + n * (now.t - tr[sw].t);
      const cmDr = (cmAng - X.R.ctx.omega * now.t) * LB.RE / 1000, cmAlt = (r.extra.rcm - LB.RE) / 1000;
      const cx = Xp(cmDr), cy = Yp(cmAlt);
      g.strokeStyle = css('--ink'); g.lineWidth = 2.2; g.beginPath(); g.moveTo(2 * cx - vx, 2 * cy - vy); g.lineTo(vx, vy); g.stroke();
      g.fillStyle = css('--ink'); g.beginPath(); g.arc(cx, cy, 4.5, 0, Math.PI * 2); g.fill();
    }
    g.restore();
    const isGun = r.extra && r.extra.muzzle;
    if (isGun && !burning(now)) projectile(g, vx, vy, ang, col, 18);
    else craft(g, vx, vy, ang, col, 20, burning(now));
    // event call-outs near the vehicle
    const wall = performance.now();
    T.flashes = T.flashes.filter(f => wall - f.born < 2600);
    T.flashes.slice(-2).forEach((f, k) => {
      const age = (wall - f.born) / 2600, alpha = age < 0.75 ? 1 : 1 - (age - 0.75) / 0.25;
      g.globalAlpha = alpha;
      g.font = '600 12px ' + css('--font-body');
      const tw = g.measureText(f.text).width;
      let lx = vx + 14, ly = vy - 22 - k * 22;
      if (lx + tw + 12 > W - 6) lx = vx - tw - 26;
      ly = clamp(ly, m.t + 4, m.t + ph - 20);
      g.fillStyle = css('--panel'); g.strokeStyle = css('--rule-strong'); g.lineWidth = 1;
      g.beginPath(); g.rect(lx - 6, ly - 14, tw + 12, 20); g.fill(); g.stroke();
      label(g, f.text, lx, ly, { size: 12, weight: 600 });
      g.globalAlpha = 1;
    });
  }
  function niceStep(span, n) {
    const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }
  function drawElevator(g, W, H, r, u) {
    const x = r.extra, col = css('--fam-' + r.family);
    const relAlt = (x.rRel - LB.RE) / 1000, top = Math.max(relAlt * 2.2, 60000);
    const m = { t: 40, b: 30 }, ph = H - m.t - m.b;
    const lo = 1, Yp = a => m.t + ph - (Math.log10(Math.max(lo, a)) / Math.log10(top)) * ph;
    const rx = W * 0.36;
    T.pts = [];
    for (let k = 0; k <= 40; k++) T.pts.push([rx, m.t + ph * k / 40], [rx - 30, m.t + ph * k / 40]);
    // altitude rulers
    [10, 100, 1000, 10000].forEach(a => { const y = Math.round(Yp(a)) + 0.5; g.strokeStyle = css('--rule'); g.beginPath(); g.moveTo(40, y); g.lineTo(W - 16, y); g.stroke(); label(g, nf(a) + ' km', 36, y + 3, { size: 10, color: css('--muted'), font: '--font-data', align: 'right' }); });
    const mark = (a, text, strong, left) => { const y = Yp(a); g.strokeStyle = strong ? css('--ink-2') : css('--rule-strong'); g.setLineDash([4, 4]); g.beginPath(); g.moveTo(rx - 60, y); g.lineTo(W - 16, y); g.stroke(); g.setLineDash([]); label(g, text, left ? rx - 12 : rx + 16, y - 4, { size: 11, color: css('--ink-2'), align: left ? 'right' : 'left' }); };
    mark(100, 'Kármán line', false);
    mark((X.R.ctx.D.rPark - LB.RE) / 1000, X.S.mission.dest === 'LEO' ? 'Target orbit' : 'Parking orbit', false);
    mark((LB.R_GEO - LB.RE) / 1000, 'Geostationary · 35,786 km', true);
    mark(relAlt, `Release · ${nf(relAlt)} km`, true, Math.abs(Math.log10(relAlt / 35786)) < 0.12);
    g.fillStyle = css('--earth'); g.fillRect(0, Yp(lo), W, H - Yp(lo));
    g.strokeStyle = css('--ink-2'); g.lineWidth = 2; g.beginPath(); g.moveTo(rx, Yp(lo)); g.lineTo(rx, 0); g.stroke();
    const tc = simTime(r, u), p = at(r.traj, tc), cy = Yp(Math.max(lo, p.alt));
    g.strokeStyle = col; g.globalAlpha = 0.3; g.lineWidth = 5; g.beginPath(); g.moveTo(rx - 50, Yp(lo)); g.lineTo(rx - 8, cy + 10); g.stroke(); g.globalAlpha = 1;
    g.strokeStyle = 'rgba(255,248,225,0.9)'; g.lineWidth = 1.2; g.stroke();
    g.fillStyle = css('--panel-2'); g.strokeStyle = css('--ink'); g.lineWidth = 1.4; g.beginPath(); g.rect(rx - 9, cy - 12, 18, 24); g.fill(); g.stroke();
    g.fillStyle = col; g.fillRect(rx - 13, cy + 11, 26, 4);
    if (u > 0.985) { // payload let go: it falls away into its ellipse
      const k = (u - 0.985) / 0.015;
      projectile(g, rx + 20 + k * 60, cy + k * 40, 0.5, col, 16);
    }
    label(g, 'Altitude on a log scale · Earth-fixed frame', W - 16, H - 10, { size: 10, color: css('--muted'), align: 'right', font: '--font-data' });
    label(g, `Apparent gravity ${X.sig(p.g, 2)} g`, rx + 16, cy + 18, { size: 11, color: css('--ink') });
  }

  function drawResult(g, W, H, r, v) {
    const a = Math.min(1, v * 4);
    g.globalAlpha = a;
    const bw = Math.min(W - 40, 480);
    g.font = '13px ' + css('--font-body');
    const lines = r.feasible
      ? [`Overall efficiency η ${F.pct(r.etaOverall)} (payload energy ÷ energy in)`, `${F.mass(r.launchMass)} launched · ${F.pct(r.payloadFraction)} payload · ${F.money(r.costPerKg)}/kg`, `Peak load ${F.g(r.peakG)} · ${F.time(r.timeToDest)} to destination`]
      : wrap(g, failText(r), bw - 40);
    const bh = 64 + lines.length * 20;
    // put the card in whichever corner the flight path leaves most empty
    let bx = W - bw - 22, by = 54;
    if (r.feasible && T.pts && T.pts.length) {
      const corners = [[66, 54], [W - bw - 22, 54], [W - bw - 22, H - bh - 44], [66, H - bh - 44]];
      let best = Infinity;
      for (const c of corners) {
        const n = T.pts.filter(q => q[0] > c[0] - 12 && q[0] < c[0] + bw + 12 && q[1] > c[1] - 12 && q[1] < c[1] + bh + 12).length;
        if (n < best) { best = n; bx = c[0]; by = c[1]; }
      }
    }
    g.fillStyle = css('--panel'); g.strokeStyle = r.feasible ? css('--good') : css('--critical'); g.lineWidth = 2;
    g.beginPath(); g.rect(bx, by, bw, bh); g.fill(); g.stroke();
    g.fillStyle = r.feasible ? css('--good') : css('--critical');
    g.beginPath(); g.arc(bx + 30, by + 30, 13, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 2.6; g.lineCap = 'round'; g.beginPath();
    if (r.feasible) { g.moveTo(bx + 23, by + 30); g.lineTo(bx + 28, by + 35); g.lineTo(bx + 37, by + 24); } else { g.moveTo(bx + 24, by + 24); g.lineTo(bx + 36, by + 36); g.moveTo(bx + 36, by + 24); g.lineTo(bx + 24, by + 36); }
    g.stroke(); g.lineCap = 'butt';
    const D = X.R.ctx.D;
    const rank = X.R.ranked.filter(q => q.feasible).findIndex(q => q.id === r.id);
    const title = r.feasible ? `Reached ${D.short}` + (rank >= 0 ? ` · rank ${rank + 1}, score ${r.score.toFixed(0)}` : '') : 'Cannot do this job';
    label(g, title, bx + 54, by + 36, { size: 17, weight: 750, font: '--font-display' });
    lines.forEach((t, i) => label(g, t, bx + 20, by + 64 + i * 20, { size: 13, color: css('--ink-2'), font: r.feasible ? '--font-data' : '--font-body' }));
    g.globalAlpha = 1;
  }

  function draw() {
    const cv = $('#thCanvas');
    if (!cv) return;
    const W = cv.clientWidth || 800, H = cv.clientHeight || 460;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = css('--panel'); g.fillRect(0, 0, W, H);
    const r = cur();
    if (!r) { label(g, 'Run the trials to watch each method fly.', W / 2, H / 2, { size: 14, color: css('--muted'), align: 'center' }); return; }
    // a method that cannot carry this payload stops halfway through its launch sequence
    if (T.stage === 'pre' || (!r.feasible && T.stage === 'hold')) drawPrelude(g, W, H, r, r.feasible ? T.u : Math.min(T.stage === 'pre' ? T.u : 1, 0.5));
    else drawFlight(g, W, H, r, T.stage === 'fly' ? Math.min(1, T.u) : 1);
    if (T.stage === 'hold') drawResult(g, W, H, r, T.u);
    // stage tag
    const tag = `${T.i + 1}/${T.order.length} · ${METHOD[r.id].short}`;
    g.font = '600 12px ' + css('--font-body');
    const tw = g.measureText(tag).width;
    g.fillStyle = css('--ink'); g.fillRect(W - tw - 30, 12, tw + 18, 22);
    label(g, tag, W - tw - 21, 27, { size: 12, weight: 600, color: css('--panel') });
    if (T.stage === 'fly') {
      const wtxt = '×' + nf(Math.max(1, warp(r, Math.min(1, T.u)))) + ' real time';
      label(g, wtxt, W - 22, 50, { size: 11, color: css('--muted'), align: 'right', font: '--font-data' });
    }
  }

  // ───────────── wiring ─────────────
  $('#thPlay').addEventListener('click', () => { if (T.playing) pause(); else play(); });
  $('#thPrev').addEventListener('click', () => { goto(T.i - 1); if (!T.playing) draw(); });
  $('#thNext').addEventListener('click', () => { if (T.stage !== 'hold' && cur()) T.status[cur().id] = cur().feasible ? 'done' : 'failed'; goto(T.i + 1); if (!T.playing) draw(); });
  $('#thSpeed').addEventListener('change', e => { T.speed = +e.target.value; });
  if (window.IntersectionObserver) new IntersectionObserver(es => { T.visible = es[0].isIntersecting; }, { threshold: 0.15 }).observe($('#theatre'));
  window.addEventListener('resize', () => draw());
  if (matchMedia('(prefers-color-scheme: dark)').addEventListener) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => draw());
  // test hook: advance the sequence by wall-clock seconds without waiting (hidden previews never tick)
  function step(sec) { const n = Math.ceil(sec / 0.05); for (let k = 0; k < n; k++) advance(0.05 * T.speed); draw(); updateSide(); return { i: T.i, id: T.order[T.i], stage: T.stage, u: T.u, finished: T.finished }; }
  window.LBTheatre = { onResults, goto, play, pause, T, draw, simTime, step, _scene: { drawPrelude, drawFlight, drawResult } };
  if (X.R.results && X.R.results.length) onResults();
  else draw();
})();
