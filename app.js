/* LAUNCHBENCH interface. All physics lives in engine.js (window.LB); this file only drives it and draws. */
(function () {
  'use strict';
  const LB = window.LB;
  const $ = (s, root) => (root || document).querySelector(s);
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ───────────────────────── tiny DOM helpers ─────────────────────────
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  }
  function sv(tag, attrs, text) {
    const e = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  const tick = () => new Promise(r => setTimeout(r, 0));

  // ───────────────────────── number formatting ─────────────────────────
  const nf = (v, d) => v.toLocaleString('en-US', { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 });
  function sig(v, n) {
    n = n || 3;
    if (v == null || !isFinite(v)) return '–';
    const a = Math.abs(v);
    if (a === 0) return '0';
    const d = Math.max(0, Math.min(6, n - 1 - Math.floor(Math.log10(a))));
    return nf(v, d);
  }
  const F = {
    mass: kg => kg == null ? '–' : kg < 1000 ? sig(kg, 3) + ' kg' : kg < 1e6 ? sig(kg / 1000, 3) + ' t' : nf(kg / 1000) + ' t',
    money: v => v == null ? '–' : v >= 1e9 ? '$' + sig(v / 1e9, 3) + 'B' : v >= 1e6 ? '$' + sig(v / 1e6, 3) + 'M' : v >= 1e3 ? '$' + sig(v / 1e3, 3) + 'k' : '$' + sig(v, 3),
    energy: J => J == null ? '–' : J >= 1e12 ? sig(J / 1e12, 3) + ' TJ' : J >= 1e9 ? sig(J / 1e9, 3) + ' GJ' : J >= 1e6 ? sig(J / 1e6, 3) + ' MJ' : sig(J / 1e3, 3) + ' kJ',
    ePerKg: J => J == null ? '–' : J >= 1e9 ? sig(J / 1e9, 3) + ' GJ/kg' : sig(J / 1e6, 3) + ' MJ/kg',
    pct: f => f == null ? '–' : sig(f * 100, f * 100 >= 10 ? 3 : 2) + '%',
    g: g => g == null ? '–' : g < 10 ? sig(g, 2) + ' g' : nf(g) + ' g',
    speed: v => v == null ? '–' : Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) + ' km/s' : nf(v) + ' m/s',
    dv: v => v == null ? '–' : nf(v) + ' m/s',
    km: k => k == null ? '–' : (Math.abs(k) >= 100 ? nf(k) : sig(k, 3)) + ' km',
    co2: k => k == null ? '–' : sig(k, 3) + ' kg',
    power: W => W >= 1e9 ? sig(W / 1e9, 3) + ' GW' : W >= 1e6 ? sig(W / 1e6, 3) + ' MW' : sig(W / 1e3, 3) + ' kW',
    time(s) {
      if (s == null || !isFinite(s)) return '–';
      if (s < 90) return Math.round(s) + ' s';
      if (s < 5400) return sig(s / 60, 2) + ' min';
      if (s < 2 * 86400) return sig(s / 3600, 2) + ' h';
      if (s < 365 * 86400) return sig(s / 86400, 2) + ' days';
      return sig(s / (365.25 * 86400), 2) + ' years';
    },
    clock(s) {
      if (s == null || !isFinite(s)) return '–';
      const sign = s < 0 ? 'T− ' : 'T+ ';
      s = Math.abs(s);
      if (s < 60) return sign + s.toFixed(1) + ' s';
      if (s < 3600) return sign + Math.floor(s / 60) + ' min ' + String(Math.floor(s % 60)).padStart(2, '0') + ' s';
      if (s < 2 * 86400) return sign + (s / 3600).toFixed(2) + ' h';
      return sign + (s / 86400).toFixed(2) + ' days';
    },
  };

  // ───────────────────────── reference data ─────────────────────────
  const PRESETS = [
    { id: 'hardsat', name: 'Hardened smallsat', mass: 200, g: 12000, rho: 800 },
    { id: 'cargo', name: 'Water & propellant', mass: 1000, g: 30000, rho: 1000 },
    { id: 'cubesat', name: 'CubeSat 6U', mass: 12, g: 60, rho: 600 },
    { id: 'sat', name: 'Standard satellite', mass: 1500, g: 15, rho: 300 },
    { id: 'crew', name: 'Crew capsule', mass: 8000, g: 5, rho: 250 },
    { id: 'module', name: 'Station module', mass: 20000, g: 6, rho: 200 },
  ];
  const SITES = [{ n: 'Equator', v: 0 }, { n: 'Kourou', v: 5.2 }, { n: 'Sriharikota', v: 13.7 }, { n: 'Cape Canaveral', v: 28.5 }, { n: 'Baikonur', v: 45.9 }];
  const FAM = {};
  LB.FAMILIES.forEach(f => { FAM[f.id] = f; });
  const METHOD = {};
  const DASH = {}; // within-family index → dash pattern (secondary encoding for same-hue lines)
  {
    const seen = {};
    LB.METHODS.forEach(m => { METHOD[m.id] = m; const i = seen[m.family] = (seen[m.family] || 0) + 1; DASH[m.id] = [[], [7, 4], [2, 3]][i - 1] || []; });
  }
  const DEST_SHORT = { LEO: 'LEO', GEO: 'GEO', TLI: 'Moon', MARS: 'Mars', JUP: 'Jupiter' };

  function gNote(g) {
    if (g <= 6) return 'People can ride at this level.';
    if (g <= 30) return 'Ordinary satellites, qualified to about 10–20 g, survive this.';
    if (g <= 500) return 'Ruggedized hardware: potted electronics, no deployables under load.';
    if (g <= 5000) return 'Gun-hardened electronics, as in guided artillery shells.';
    return 'Only solid-state, potted hardware or bulk cargo such as water or propellant.';
  }

  // ───────────────────────── state ─────────────────────────
  const STORE = 'launchbench.v1';
  const defaults = () => ({
    preset: 'hardsat',
    payload: { mass: 200, gTol: 12000, density: 800 },
    mission: { dest: 'LEO', alt: 500, lat: 28.5, assist: false },
    econ: { perYear: 100, years: 20, elecPrice: 0.08, gridCO2: 0.35 },
    weights: Object.assign({}, LB.DEFAULT_WEIGHTS),
    enabled: Object.fromEntries(LB.METHODS.map(m => [m.id, true])),
    params: Object.fromEntries(LB.METHODS.map(m => [m.id, LB.paramDefaults(m)])),
  });
  let S = defaults();
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const saved = JSON.parse(raw), d = defaults();
      S = {
        preset: saved.preset || null,
        payload: Object.assign(d.payload, saved.payload), mission: Object.assign(d.mission, saved.mission), econ: Object.assign(d.econ, saved.econ),
        weights: Object.assign(d.weights, saved.weights), enabled: Object.assign(d.enabled, saved.enabled), params: d.params,
      };
      for (const id in saved.params || {}) if (S.params[id]) Object.assign(S.params[id], saved.params[id]);
    }
  } catch (e) { /* storage unavailable: use defaults */ }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } };

  const R = { ctx: null, results: [], ranked: [], byId: {}, selected: null, status: {}, running: false, runId: 0 };
  const play = { p: 1, timer: null, view: 'ascent' };
  const sweep = { x: 'mass', y: 'costPerKg', data: null, runId: 0, running: false, key: '' };
  const boardSort = { k: 'score', dir: -1 };

  // ───────────────────────── input rail ─────────────────────────
  const logIn = (id, get, set, fmt) => {
    const inp = $('#' + id), out = $('#' + id + 'Out');
    const show = () => { out.textContent = fmt(get()); };
    inp.value = Math.log10(get());
    inp.addEventListener('input', () => { set(Math.pow(10, +inp.value)); show(); onInputsChanged(true); });
    inp.addEventListener('change', () => onInputsChanged(false));
    show();
    return { sync() { inp.value = Math.log10(get()); show(); } };
  };
  const linIn = (id, get, set, fmt) => {
    const inp = $('#' + id), out = $('#' + id + 'Out');
    const show = () => { out.textContent = fmt(get()); };
    inp.value = get();
    inp.addEventListener('input', () => { set(+inp.value); show(); onInputsChanged(true); });
    inp.addEventListener('change', () => onInputsChanged(false));
    show();
    return { sync() { inp.value = get(); show(); } };
  };
  const roundMass = m => { const p = Math.pow(10, Math.floor(Math.log10(m)) - 1); return Math.max(1, Math.round(m / p) * p); };
  const roundG = g => g < 20 ? Math.round(g * 2) / 2 : g < 200 ? Math.round(g) : Math.round(g / 10) * 10;

  const inputs = {};
  function buildRail() {
    // presets
    const pre = $('#presets');
    PRESETS.forEach(p => {
      pre.append(h('button', { class: 'chip', type: 'button', 'data-id': p.id, 'aria-pressed': String(S.preset === p.id), onclick: () => applyPreset(p) },
        p.name, h('small', { text: `${F.mass(p.mass)} · ${nf(p.g)} g` })));
    });
    inputs.mass = logIn('mass', () => S.payload.mass, v => { S.payload.mass = roundMass(v); clearPreset(); }, v => F.mass(v));
    inputs.gTol = logIn('gTol', () => S.payload.gTol, v => { S.payload.gTol = roundG(v); clearPreset(); }, v => nf(v) + ' g');
    inputs.density = linIn('density', () => S.payload.density, v => { S.payload.density = v; clearPreset(); }, v => nf(v) + ' kg/m³');
    inputs.alt = linIn('alt', () => S.mission.alt, v => { S.mission.alt = v; }, v => nf(v) + ' km');
    inputs.lat = linIn('lat', () => S.mission.lat, v => { S.mission.lat = v; }, v => v.toFixed(1) + '°');
    inputs.perYear = logIn('perYear', () => S.econ.perYear, v => { S.econ.perYear = v < 10 ? Math.round(v) || 1 : Math.round(v / (v < 100 ? 1 : 10)) * (v < 100 ? 1 : 10); }, v => nf(v));
    inputs.years = linIn('years', () => S.econ.years, v => { S.econ.years = v; }, v => v + ' years');
    for (const id of ['elecPrice', 'gridCO2']) {
      const inp = $('#' + id);
      inp.value = S.econ[id];
      inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (isFinite(v) && v >= 0) { S.econ[id] = v; onInputsChanged(false); } else inp.value = S.econ[id]; });
    }
    const sites = $('#sites');
    SITES.forEach(s => sites.append(h('button', { class: 'chip', type: 'button', onclick: () => { S.mission.lat = s.v; inputs.lat.sync(); onInputsChanged(false); } }, s.n, h('small', { text: s.v + '°' }))));
    // destination
    $('#dest').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      S.mission.dest = b.dataset.v; syncDest(); onInputsChanged(false);
    });
    $('#assist').checked = S.mission.assist;
    $('#assist').addEventListener('change', e => { S.mission.assist = e.target.checked; syncDest(); onInputsChanged(false); });
    syncDest();
    syncG();
    buildWeights();
    buildRoster();
  }
  function syncDest() {
    for (const b of $('#dest').children) b.setAttribute('aria-pressed', String(b.dataset.v === S.mission.dest));
    $('#altField').hidden = S.mission.dest !== 'LEO';
    $('#assistField').hidden = S.mission.dest !== 'JUP';
    const D = LB.destination(S.mission);
    $('#destLabel').textContent = D.label + (S.mission.dest !== 'LEO' ? '. Ground launchers stop in a 300 km parking orbit and add a departure stage.' : '.');
  }
  function syncG() { $('#gHint').textContent = gNote(S.payload.gTol); }
  function clearPreset() {
    S.preset = null;
    for (const b of $('#presets').children) b.setAttribute('aria-pressed', 'false');
  }
  function applyPreset(p) {
    S.preset = p.id;
    S.payload.mass = p.mass; S.payload.gTol = p.g; S.payload.density = p.rho;
    for (const b of $('#presets').children) b.setAttribute('aria-pressed', String(b.dataset.id === p.id));
    inputs.mass.sync(); inputs.gTol.sync(); inputs.density.sync();
    onInputsChanged(false);
  }
  function buildWeights() {
    const box = $('#weights');
    box.textContent = '';
    LB.METRICS.forEach(M => {
      const id = 'w_' + M.k;
      const out = h('output', { for: id });
      const inp = h('input', { type: 'range', id, min: 0, max: 50, step: 1, value: S.weights[M.k] || 0 });
      const show = () => { out.textContent = S.weights[M.k] || 0; };
      inp.addEventListener('input', () => { S.weights[M.k] = +inp.value; show(); syncWSum(); rescore(); save(); });
      show();
      box.append(h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('label', { for: id, text: M.label + (M.better === 'low' ? ' (lower is better)' : '') }), out), inp));
    });
    box.append(h('button', { class: 'icon-btn', type: 'button', style: { marginTop: '10px' }, onclick: () => { S.weights = Object.assign({}, LB.DEFAULT_WEIGHTS); buildWeights(); syncWSum(); rescore(); save(); } }, 'Reset weights'));
    syncWSum();
  }
  function syncWSum() {
    const w = S.weights, tot = Object.values(w).reduce((a, b) => a + b, 0) || 1;
    const top = LB.METRICS.filter(M => w[M.k] > 0).sort((a, b) => w[b.k] - w[a.k]).slice(0, 2).map(M => `${M.label.split(' ')[0]} ${Math.round(100 * w[M.k] / tot)}%`);
    $('#wSum').textContent = top.join(' · ');
  }
  function buildRoster() {
    const box = $('#roster');
    box.textContent = '';
    LB.FAMILIES.forEach(f => {
      const blk = h('div', { class: 'fam-block' }, h('p', { class: 'fam-name' }, h('span', { class: 'sw ' + f.id }), f.name));
      LB.METHODS.filter(m => m.family === f.id).forEach(m => {
        const cid = 'en_' + m.id;
        const params = h('div', { class: 'mparams', hidden: true, id: 'mp_' + m.id });
        const gear = h('button', { class: 'gear', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'mp_' + m.id, 'aria-label': 'Settings for ' + m.name, text: 'Settings' });
        gear.addEventListener('click', () => {
          const open = params.hidden;
          params.hidden = !open; gear.setAttribute('aria-expanded', String(open));
          if (open && !params.childNodes.length) fillParams(m, params);
        });
        const cb = h('input', { type: 'checkbox', id: cid });
        cb.checked = !!S.enabled[m.id];
        cb.addEventListener('change', () => { S.enabled[m.id] = cb.checked; syncCount(); onInputsChanged(false); });
        const row = h('div', { class: 'mrow' },
          cb,
          h('label', { for: cid }, h('span', { class: 'dot-status', id: 'st_' + m.id, style: { display: 'inline-block', marginRight: '6px', verticalAlign: '1px' } }), m.short),
          h('span', { class: 'trl', title: 'Technology readiness level', text: 'TRL ' + m.trl }),
          gear, params);
        blk.append(row);
      });
      box.append(blk);
    });
    syncCount();
  }
  function syncCount() {
    const n = LB.METHODS.filter(m => S.enabled[m.id]).length;
    $('#mCount').textContent = `${n} of ${LB.METHODS.length}`;
  }
  function fillParams(m, box) {
    box.textContent = '';
    m.params.forEach(p => {
      const id = `p_${m.id}_${p.k}`;
      const out = h('output', { for: id });
      const inp = h('input', { type: 'range', id, min: p.min, max: p.max, step: p.step, value: S.params[m.id][p.k] });
      const show = () => { const v = S.params[m.id][p.k]; out.textContent = (Math.abs(v) >= 1000 ? nf(v) : String(+v.toFixed(3))) + (p.unit ? ' ' + p.unit : ''); };
      inp.addEventListener('input', () => { S.params[m.id][p.k] = +inp.value; show(); });
      inp.addEventListener('change', () => onInputsChanged(false));
      show();
      box.append(h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('label', { for: id, text: p.label }), out), inp));
    });
    box.append(h('button', { class: 'reset', type: 'button', onclick: () => { S.params[m.id] = LB.paramDefaults(m); fillParams(m, box); onInputsChanged(false); } }, 'Reset to defaults'));
  }

  let runTimer = null;
  function onInputsChanged(live) {
    syncG();
    save();
    $('#taSerial').textContent = `${F.mass(S.payload.mass)} · ${nf(S.payload.gTol)} g`;
    if (live) return; // wait for the slider to be released
    clearTimeout(runTimer);
    runTimer = setTimeout(runTrials, 250);
  }

  // ───────────────────────── running the trials ─────────────────────────
  function setStatus(id, st) {
    R.status[id] = st;
    const d = $('#st_' + id);
    if (d) d.className = 'dot-status ' + (st || '');
  }
  async function runTrials() {
    const myId = ++R.runId;
    R.running = true;
    const btn = $('#runBtn');
    btn.disabled = true;
    sweep.runId++; // cancel any sweep in flight
    const ctx = LB.makeContext({ payload: Object.assign({}, S.payload), mission: Object.assign({}, S.mission), econ: Object.assign({}, S.econ) });
    const ids = LB.METHODS.filter(m => S.enabled[m.id]).map(m => m.id);
    LB.METHODS.forEach(m => setStatus(m.id, S.enabled[m.id] ? '' : ''));
    document.querySelector('.record').style.opacity = '0.62';
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      setStatus(ids[i], 'run');
      $('#runState').textContent = `Flying ${i + 1}/${ids.length}: ${METHOD[ids[i]].short}`;
      $('#progress').style.width = (100 * i / ids.length) + '%';
      await tick();
      if (myId !== R.runId) return;
      const res = LB.runMethod(ids[i], ctx, S.params[ids[i]]);
      out.push(res);
      setStatus(ids[i], res.feasible ? 'ok' : 'fail');
    }
    if (myId !== R.runId) return;
    $('#progress').style.width = '100%';
    setTimeout(() => { if (myId === R.runId) $('#progress').style.width = '0'; }, 400);
    document.querySelector('.record').style.opacity = '';
    R.ctx = ctx; R.results = out; R.byId = Object.fromEntries(out.map(r => [r.id, r]));
    R.running = false; btn.disabled = false;
    const nOk = out.filter(r => r.feasible).length;
    $('#runState').textContent = `${nOk} of ${out.length} methods reached ${DEST_SHORT[S.mission.dest]}`;
    rescore(true);
    if (!R.selected || !R.byId[R.selected] || !R.byId[R.selected].feasible) R.selected = R.ranked.length && R.ranked[0].feasible ? R.ranked[0].id : null;
    renderAll();
    sweep.data = null;
    renderSweep();
    setTimeout(() => { if (myId === R.runId) runSweep(); }, 300);
  }
  function rescore(silent) {
    if (!R.results.length) return;
    R.ranked = LB.score(R.results, S.weights);
    if (!silent) { renderVerdict(); renderBoard(); }
  }

  // ───────────────────────── verdict ─────────────────────────
  const metricDefs = {
    eff: { label: 'Energy', better: 'high', fmt: F.pct },
    costPerKg: { label: 'Cost', better: 'low', fmt: v => F.money(v) + '/kg' },
    payloadFraction: { label: 'Mass', better: 'high', fmt: v => F.pct(v) + ' payload' },
    trl: { label: 'Readiness', better: 'high', fmt: v => 'TRL ' + v },
    co2PerKg: { label: 'Emissions', better: 'low', fmt: v => sig(v, 3) + ' kg CO₂/kg' },
    timeToDest: { label: 'Speed', better: 'low', fmt: v => F.time(v) },
  };
  function bestBy(k) {
    const ok = R.results.filter(r => r.feasible && r[k] != null);
    if (!ok.length) return null;
    const d = metricDefs[k];
    return ok.reduce((a, b) => (d.better === 'high' ? (b[k] > a[k] ? b : a) : (b[k] < a[k] ? b : a)));
  }
  function renderVerdict() {
    const box = $('#verdict');
    box.textContent = '';
    const ok = R.ranked.filter(r => r.feasible);
    const D = R.ctx.D, P = R.ctx.payload;
    const mission = `${F.mass(P.mass)} payload rated to ${nf(P.gTol)} g → ${D.short}${S.mission.dest !== 'LEO' ? '' : ''}, ${S.mission.lat.toFixed(1)}° latitude, ${nf(S.econ.perYear)} launches a year`;
    if (!ok.length) {
      box.append(h('div', { class: 'verdict-main', style: { gridColumn: '1 / -1' } },
        h('p', { class: 'eyebrow', text: 'Verdict' }), h('p', { class: 'verdict-title', text: 'No method can do this job' }),
        h('p', { class: 'verdict-why', text: 'Every enabled method failed. Try a lighter payload, a higher g-tolerance, or enable more methods.' })));
      return;
    }
    const w = ok[0];
    const reasons = [];
    const keys = Object.keys(metricDefs).filter(k => (S.weights[k] || 0) > 0).sort((a, b) => S.weights[b] - S.weights[a]);
    for (const k of keys) {
      const b = bestBy(k);
      if (b && b.id === w.id) reasons.push(`the best ${metricDefs[k].label.toLowerCase()} figure (${metricDefs[k].fmt(w[k])})`);
    }
    const strengths = Object.keys(w.scores || {}).filter(k => (S.weights[k] || 0) > 0).sort((a, b) => (S.weights[b] * w.scores[b]) - (S.weights[a] * w.scores[a])).slice(0, 2);
    const why = h('p', { class: 'verdict-why' });
    if (reasons.length) why.append('It has ', h('b', { text: reasons.slice(0, 2).join(' and ') }), '. ');
    else if (strengths.length) why.append('It never wins a single category outright but is the best all-rounder, strongest on ', h('b', { text: strengths.map(k => metricDefs[k].label.toLowerCase()).join(' and ') }), '. ');
    why.append(`It lifts ${F.mass(w.launchMass)} from the ground, spends ${F.ePerKg(w.energyPerKg)} and ${F.money(w.costPerKg)} per kilogram delivered, and pulls ${F.g(w.peakG)} at worst.`);
    const runner = ok[1];
    if (runner) why.append(' Runner-up: ', h('b', { text: runner.name }), ` (${runner.score.toFixed(0)}).`);
    const main = h('div', { class: 'verdict-main' },
      h('p', { class: 'eyebrow', text: 'Most efficient for this payload' }),
      h('h2', { class: 'verdict-title', text: METHOD[w.id].short }),
      h('p', { class: 'verdict-full', text: w.name + ' · TRL ' + w.trl }),
      h('div', { class: 'verdict-score' }, h('strong', { text: w.score.toFixed(0) }), h('span', { text: '/ 100 weighted score' })),
      why,
      h('p', { class: 'verdict-mission', text: mission }));
    const pod = h('div', { class: 'podium' }, h('p', { class: 'eyebrow', style: { marginBottom: '4px' }, text: 'Category leaders' }));
    for (const k of Object.keys(metricDefs)) {
      const b = bestBy(k);
      if (!b) continue;
      pod.append(h('div', { class: 'pod' },
        h('span', { class: 'k', text: metricDefs[k].label }),
        h('span', { class: 'm' }, h('span', { class: 'sw ' + b.family }), h('span', { text: METHOD[b.id].short })),
        h('span', { class: 'v', text: metricDefs[k].fmt(b[k]) })));
    }
    box.append(main, pod);
    const out = R.results.filter(r => !r.feasible);
    if (out.length) {
      const p = h('div', { class: 'ruled-out' }, h('b', { text: `${out.length} ${out.length === 1 ? 'method cannot' : 'methods cannot'} do this job: ` }));
      out.forEach((r, i) => { p.append(h('span', { text: `${METHOD[r.id].short} (${shortReason(r)})${i < out.length - 1 ? '; ' : '.'}` })); });
      box.append(p);
    }
  }
  function shortReason(r) {
    const f = r.issues.find(i => i.level === 'fail');
    if (!f) return 'failed';
    const t = f.text;
    if (/g limit|g-limit|limit this launcher/.test(t)) return 'too violent for this payload';
    if (/balloon/.test(t)) return 'too heavy for a balloon';
    if (/carrier/.test(t)) return 'too heavy for any carrier aircraft';
    if (/taper/.test(t)) return 'no ribbon material is strong enough';
    if (/stage technology|close/.test(t)) return 'stages too small to close at this size';
    if (/Tip|tether|fibre/.test(t)) return 'tether limits';
    return t.length > 60 ? t.slice(0, 57) + '…' : t;
  }

  // ───────────────────────── leaderboard ─────────────────────────
  const COLS = [
    { k: 'rank', label: '#', sort: false },
    { k: 'name', label: 'Method', sort: false },
    { k: 'score', label: 'Score', fmt: r => r.score },
    { k: 'eff', label: 'Energy eff.', fmt: r => F.pct(r.eff), dir: -1 },
    { k: 'energyPerKg', label: 'Energy/kg', fmt: r => F.ePerKg(r.energyPerKg), dir: 1 },
    { k: 'costPerKg', label: 'Cost/kg', fmt: r => F.money(r.costPerKg), dir: 1 },
    { k: 'launchMass', label: 'Launch mass', fmt: r => F.mass(r.launchMass), dir: 1 },
    { k: 'payloadFraction', label: 'Payload frac.', fmt: r => F.pct(r.payloadFraction), dir: -1 },
    { k: 'peakG', label: 'Peak load', fmt: r => F.g(r.peakG), dir: 1 },
    { k: 'co2PerKg', label: 'CO₂/kg', fmt: r => F.co2(r.co2PerKg), dir: 1 },
    { k: 'timeToDest', label: 'Time', fmt: r => F.time(r.timeToDest), dir: 1 },
    { k: 'trl', label: 'TRL', fmt: r => r.trl, dir: -1 },
  ];
  function renderBoard() {
    const t = $('#board');
    t.textContent = '';
    const thead = h('thead'), tr = h('tr');
    COLS.forEach(c => {
      const th = h('th', { scope: 'col' });
      if (c.sort === false) th.textContent = c.label;
      else {
        th.append(h('button', { type: 'button', text: c.label, onclick: () => { if (boardSort.k === c.k) boardSort.dir *= -1; else { boardSort.k = c.k; boardSort.dir = c.k === 'score' ? -1 : (c.dir || 1); } renderBoard(); } }));
        if (boardSort.k === c.k) th.setAttribute('aria-sort', boardSort.dir < 0 ? 'descending' : 'ascending');
      }
      tr.append(th);
    });
    thead.append(tr);
    const ok = R.ranked.filter(r => r.feasible), out = R.ranked.filter(r => !r.feasible);
    const rankOf = Object.fromEntries(ok.map((r, i) => [r.id, i + 1]));
    const sorted = ok.slice().sort((a, b) => {
      const va = a[boardSort.k], vb = b[boardSort.k];
      return boardSort.dir * ((va == null ? Infinity : va) - (vb == null ? Infinity : vb));
    });
    const tb = h('tbody');
    sorted.concat(out).forEach(r => {
      const row = h('tr', { class: (r.feasible ? '' : 'out ') + (r.id === R.selected ? 'sel' : ''), tabindex: '0', 'aria-label': r.name });
      row.addEventListener('click', () => select(r.id, true));
      row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(r.id, true); } });
      const warn = r.issues.some(i => i.level === 'warn');
      const nameCell = h('td', { class: 'name' }, h('span', { class: 'mname' }, h('span', { class: 'sw ' + r.family }), r.name));
      if (!r.feasible) nameCell.append(h('span', { class: 'mfail', text: (r.issues.find(i => i.level === 'fail') || {}).text || '' }));
      row.append(h('td', {}, h('span', { class: 'rank', text: r.feasible ? rankOf[r.id] : '–' })), nameCell);
      COLS.slice(2).forEach(c => {
        if (c.k === 'score') {
          row.append(h('td', {}, r.feasible
            ? h('span', { class: 'scorebar' }, h('s', {}, h('i', { style: { width: Math.max(2, r.score) + '%' } })), h('span', { text: r.score.toFixed(0) }))
            : h('span', { class: 'pill fail', text: 'Not viable' })));
        } else row.append(h('td', { text: r.feasible ? c.fmt(r) : (c.k === 'trl' ? r.trl : '–') }));
      });
      if (r.feasible && warn) row.children[1].firstChild.append(h('span', { class: 'pill warn', style: { marginLeft: '6px' }, title: r.issues.filter(i => i.level === 'warn').map(i => i.text).join('\n'), text: 'flag' }));
      tb.append(row);
    });
    t.append(thead, tb);
  }

  // ───────────────────────── selection ─────────────────────────
  function select(id, scroll) {
    if (!R.byId[id]) return;
    R.selected = id;
    renderBoard();
    renderTele();
    drawRange();
    renderDossier();
    renderCharts();
    const sel = $('#teleSel');
    if (sel.value !== id) sel.value = id;
    if (scroll === true) $('#dossier').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  // ───────────────────────── range view ─────────────────────────
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const famColor = f => css('--fam-' + f);
  function sampleAt(traj, t) {
    if (!traj.length) return null;
    if (t <= traj[0].t) return traj[0];
    for (let i = 1; i < traj.length; i++) {
      if (traj[i].t >= t) {
        const a = traj[i - 1], b = traj[i], u = (t - a.t) / Math.max(1e-9, b.t - a.t);
        const o = {};
        for (const k of ['t', 'alt', 'dr', 'v', 'vrel', 'g', 'q', 'm', 'x', 'y']) o[k] = a[k] + (b[k] - a[k]) * u;
        o.phase = a.phase; return o;
      }
    }
    return traj[traj.length - 1];
  }
  const tAt = (traj, p) => traj[0].t + (traj[traj.length - 1].t - traj[0].t) * p;

  function niceStep(span, n) {
    const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }
  function drawRange() {
    const cv = $('#rangeCanvas');
    const W = cv.clientWidth || 800, H = cv.clientHeight || 440;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = css('--panel'); g.fillRect(0, 0, W, H);
    if (!R.results.length) return;
    const ok = R.results.filter(r => r.feasible && r.traj && r.traj.length > 1);
    if (play.view === 'ascent') drawAscent(g, W, H, ok); else drawOrbit(g, W, H, ok);
  }
  function drawAscent(g, W, H, ok) {
    const D = R.ctx.D;
    const tAlt = (D.rPark - LB.RE) / 1000;
    const yMax = Math.max(260, tAlt * 1.4);
    let xMax = 600;
    for (const r of ok) { if (r.id === 'elevator') continue; for (const p of r.traj) if (p.alt <= yMax && p.dr > xMax) xMax = p.dr; }
    xMax = Math.min(xMax * 1.04, 9000);
    const m = { l: 56, r: 16, t: 16, b: 34 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const X = d => m.l + (d / xMax) * pw, Y = a => m.t + ph - (a / yMax) * ph;
    // sky
    const sky = g.createLinearGradient(0, Y(0), 0, Y(100));
    sky.addColorStop(0, css('--sky-low')); sky.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sky; g.fillRect(m.l, Y(100), pw, Y(0) - Y(100));
    // grid
    g.font = '10px ' + css('--font-data'); g.lineWidth = 1;
    const ys = niceStep(yMax, 5), xs = niceStep(xMax, 7);
    g.strokeStyle = css('--rule'); g.fillStyle = css('--muted');
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let a = 0; a <= yMax + 1e-9; a += ys) { g.beginPath(); g.moveTo(m.l, Math.round(Y(a)) + 0.5); g.lineTo(m.l + pw, Math.round(Y(a)) + 0.5); g.stroke(); g.fillText(nf(a), m.l - 6, Y(a)); }
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let d = 0; d <= xMax + 1e-9; d += xs) { g.beginPath(); g.moveTo(Math.round(X(d)) + 0.5, m.t); g.lineTo(Math.round(X(d)) + 0.5, m.t + ph); g.stroke(); g.fillText(nf(d), X(d), m.t + ph + 6); }
    g.fillStyle = css('--ink-2'); g.font = '11px ' + css('--font-body');
    g.fillText('Downrange (km)', m.l + pw / 2, H - 14);
    g.save(); g.translate(14, m.t + ph / 2); g.rotate(-Math.PI / 2); g.textBaseline = 'middle'; g.fillText('Altitude (km)', 0, 0); g.restore();
    // reference lines
    g.strokeStyle = css('--rule-strong'); g.beginPath(); g.moveTo(m.l, Y(0) + 0.5); g.lineTo(m.l + pw, Y(0) + 0.5); g.stroke();
    const refLine = (a, label) => {
      g.strokeStyle = css('--ink-2'); g.globalAlpha = 0.45; g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(m.l, Math.round(Y(a)) + 0.5); g.lineTo(m.l + pw, Math.round(Y(a)) + 0.5); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
      g.fillStyle = css('--ink-2'); g.font = '11px ' + css('--font-body'); g.textAlign = 'left'; g.textBaseline = 'bottom';
      g.fillText(label, m.l + 6, Y(a) - 3);
    };
    refLine(100, 'Kármán line · 100 km');
    refLine(tAlt, (S.mission.dest === 'LEO' ? 'Target orbit · ' : 'Parking orbit · ') + nf(tAlt) + ' km');
    // trajectories
    g.save(); g.beginPath(); g.rect(m.l, m.t - 2, pw, ph + 2); g.clip();
    const sel = R.selected;
    const order = ok.slice().sort((a, b) => (a.id === sel) - (b.id === sel));
    const markers = [];
    for (const r of order) {
      const isSel = r.id === sel;
      const col = famColor(r.family);
      const tr = r.traj, tc = tAt(tr, play.p);
      g.strokeStyle = col; g.lineWidth = isSel ? 2.6 : 1.5; g.globalAlpha = isSel ? 1 : 0.45; g.setLineDash(DASH[r.id]);
      g.lineJoin = 'round'; g.lineCap = 'round';
      g.beginPath();
      let started = false, last = null;
      for (let i = 0; i < tr.length; i++) {
        let p = tr[i];
        if (p.t > tc) { p = sampleAt(tr, tc); }
        const px = X(r.id === 'elevator' ? 0 : p.dr), py = Y(Math.min(p.alt, yMax * 3));
        if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
        last = p;
        if (tr[i].t > tc) break;
      }
      g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
      if (last) markers.push({ r, x: X(r.id === 'elevator' ? 0 : last.dr), y: Y(Math.min(last.alt, yMax)), off: last.alt > yMax, isSel, col });
    }
    g.restore();
    for (const mk of markers) {
      g.beginPath(); g.arc(mk.x, Math.max(m.t + 4, mk.y), mk.isSel ? 5.5 : 3.5, 0, Math.PI * 2);
      g.fillStyle = mk.col; g.fill(); g.lineWidth = 2; g.strokeStyle = css('--panel'); g.stroke();
      if (mk.isSel) {
        g.fillStyle = css('--ink'); g.font = '600 12px ' + css('--font-body'); g.textBaseline = 'bottom';
        const label = METHOD[mk.r.id].short + (mk.off ? ' ↑ off chart' : '');
        const tw = g.measureText(label).width;
        const lx = Math.min(Math.max(mk.x + 9, m.l + 4), m.l + pw - tw - 4);
        g.textAlign = 'left'; g.fillText(label, lx, Math.max(m.t + 16, mk.y - 8));
      }
    }
    if (R.byId.elevator && R.byId.elevator.feasible) {
      g.fillStyle = css('--muted'); g.font = '11px ' + css('--font-body'); g.textAlign = 'right'; g.textBaseline = 'top';
      let note = 'Space elevator climbs straight up, off this chart: see the orbital view';
      if (g.measureText(note).width > pw - 12) note = 'Elevator: see orbital view';
      g.fillText(note, m.l + pw - 6, m.t + 4);
    }
  }
  function drawOrbit(g, W, H, ok) {
    const D = R.ctx.D;
    const r = R.byId[R.selected];
    let ext = D.rPark / 1000;
    if (r && r.traj) for (const p of r.traj) ext = Math.max(ext, Math.hypot(p.x, p.y));
    if (r && r.id === 'elevator') ext = Math.max(ext, (LB.RE + r.params.top) / 1000 * 0.35, r.extra.rRel / 1000 * 1.05);
    if (r && r.id === 'rotovator') ext = Math.max(ext, (r.extra.rcm + r.extra.L) / 1000);
    if (r && r.orbitAfter) { const e0 = LB.elems(r.orbitAfter.x, r.orbitAfter.y, r.orbitAfter.vx, r.orbitAfter.vy); ext = Math.max(ext, Math.min(isFinite(e0.ra) ? e0.ra / 1000 : Infinity, 4 * LB.RE / 1000)); }
    ext *= 1.12;
    const cx = W / 2, cy = H / 2, sc = (Math.min(W, H) / 2 - 18) / ext;
    const P = (x, y) => [cx + x * sc, cy - y * sc];
    const RE = LB.RE / 1000;
    // atmosphere + earth
    g.beginPath(); g.arc(cx, cy, (RE + 100) * sc, 0, Math.PI * 2); g.fillStyle = css('--sky-low'); g.fill();
    g.beginPath(); g.arc(cx, cy, RE * sc, 0, Math.PI * 2); g.fillStyle = css('--earth'); g.fill();
    // target orbit
    g.strokeStyle = css('--ink-2'); g.globalAlpha = 0.5; g.setLineDash([4, 4]); g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, D.rPark / 1000 * sc, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    if (S.mission.dest === 'GEO' || (r && r.id === 'elevator')) {
      g.strokeStyle = css('--rule-strong'); g.beginPath(); g.arc(cx, cy, LB.R_GEO / 1000 * sc, 0, Math.PI * 2); g.stroke();
      g.fillStyle = css('--muted'); g.font = '10px ' + css('--font-data'); g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.fillText('GEO', cx, cy - LB.R_GEO / 1000 * sc - 2);
    }
    // other methods faint
    for (const o of ok) {
      if (o.id === R.selected || o.id === 'elevator') continue;
      g.strokeStyle = famColor(o.family); g.globalAlpha = 0.22; g.lineWidth = 1;
      g.beginPath(); o.traj.forEach((p, i) => { const q = P(p.x, p.y); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }); g.stroke();
    }
    g.globalAlpha = 1;
    if (!r || !r.feasible) return;
    const tc = tAt(r.traj, play.p);
    const col = famColor(r.family);
    // method furniture
    if (r.id === 'rotovator') {
      g.strokeStyle = css('--ink-2'); g.globalAlpha = 0.4; g.lineWidth = 1; g.setLineDash([2, 4]);
      g.beginPath(); g.arc(cx, cy, r.extra.rcm / 1000 * sc, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
      const cur = sampleAt(r.traj, tc);
      if (cur && cur.phase === 'Riding the tether') {
        const ang = Math.atan2(cur.y, cur.x);
        const swingIdx = r.traj.findIndex(p => p.phase === 'Riding the tether');
        const ang0 = Math.atan2(r.traj[swingIdx].y, r.traj[swingIdx].x);
        const n = Math.sqrt(LB.MU / Math.pow(r.extra.rcm, 3));
        const cmAng = ang0 + n * (cur.t - r.traj[swingIdx].t);
        const c = P(r.extra.rcm / 1000 * Math.cos(cmAng), r.extra.rcm / 1000 * Math.sin(cmAng)), tp = P(cur.x, cur.y);
        g.strokeStyle = css('--ink'); g.lineWidth = 2.5; g.lineCap = 'round'; g.beginPath(); g.moveTo(2 * c[0] - tp[0], 2 * c[1] - tp[1]); g.lineTo(tp[0], tp[1]); g.stroke();
        g.fillStyle = css('--ink'); g.beginPath(); g.arc(c[0], c[1], 4.5, 0, Math.PI * 2); g.fill();
        g.font = '10px ' + css('--font-body'); g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText('tether facility', c[0] + 8, c[1]);
        void ang;
      }
    }
    // the orbit the payload is on after cutoff or release (before any trim or kick)
    if (r.orbitAfter) {
      const pts = orbitPath(r.orbitAfter);
      g.strokeStyle = col; g.globalAlpha = 0.7; g.lineWidth = 1.2; g.setLineDash([5, 4]);
      g.beginPath();
      let pen = false;
      for (const q0 of pts) { if (Math.hypot(q0[0], q0[1]) < RE) { pen = false; continue; } const q = P(q0[0], q0[1]); pen ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); pen = true; }
      g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    }
    if (r.id === 'elevator') {
      const ang = 0; // Earth-fixed frame: the ribbon stands still
      const rTop = (LB.RE + r.params.top) / 1000;
      const a = P(RE * Math.cos(ang), RE * Math.sin(ang)), b = P(rTop * Math.cos(ang), rTop * Math.sin(ang));
      g.strokeStyle = css('--ink-2'); g.lineWidth = 1.2; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      const rr = r.extra.rRel / 1000, q = P(rr * Math.cos(ang), rr * Math.sin(ang));
      g.strokeStyle = col; g.lineWidth = 1; g.beginPath(); g.arc(q[0], q[1], 6, 0, Math.PI * 2); g.stroke();
      g.fillStyle = css('--muted'); g.font = '10px ' + css('--font-body'); g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText('release point', q[0] - 20, q[1] - 14);
    }
    // path so far
    g.strokeStyle = col; g.lineWidth = 2.4; g.lineJoin = 'round'; g.setLineDash(DASH[r.id]);
    g.beginPath();
    let last = null;
    for (let i = 0; i < r.traj.length; i++) {
      let p = r.traj[i];
      if (p.t > tc) p = sampleAt(r.traj, tc);
      const q = P(p.x, p.y);
      i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]);
      last = p;
      if (r.traj[i].t > tc) break;
    }
    g.stroke(); g.setLineDash([]);
    // launch site (rotates with Earth, except in the elevator's Earth-fixed frame)
    const site = r.id === 'elevator' ? 0 : LB.OMEGA * Math.cos(S.mission.lat * Math.PI / 180) * Math.max(0, tc);
    const s1 = P(RE * Math.cos(site), RE * Math.sin(site));
    g.fillStyle = css('--ink'); g.beginPath(); g.arc(s1[0], s1[1], 3, 0, Math.PI * 2); g.fill();
    if (last) { const q = P(last.x, last.y); g.beginPath(); g.arc(q[0], q[1], 5.5, 0, Math.PI * 2); g.fillStyle = col; g.fill(); g.lineWidth = 2; g.strokeStyle = css('--panel'); g.stroke(); }
    // scale bar
    const bar = niceStep(ext, 3);
    g.strokeStyle = css('--ink-2'); g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(16, H - 16); g.lineTo(16 + bar * sc, H - 16); g.stroke();
    g.fillStyle = css('--ink-2'); g.font = '10px ' + css('--font-data'); g.textAlign = 'left'; g.textBaseline = 'bottom';
    g.fillText(nf(bar) + ' km', 16, H - 20);
    g.textAlign = 'right';
    g.fillText(r.id === 'elevator' ? 'Earth-fixed frame · dashed: orbit after release' : 'Inertial frame · dashed: orbit at cutoff or release', W - 10, H - 8);
  }
  // Sample the two-body path from a state (metres) for drawing: one period if bound, a few days if not.
  function orbitPath(st) {
    const el = LB.elems(st.x, st.y, st.vx, st.vy), pts = [];
    if (el.eps < 0 && el.e < 0.97) {
      const T = 2 * Math.PI * Math.sqrt(el.a * el.a * el.a / LB.MU);
      for (let i = 0; i <= 240; i++) { const q = LB.keplerPropagate(st.x, st.y, st.vx, st.vy, T * i / 240); pts.push([q.x / 1000, q.y / 1000]); }
      return pts;
    }
    let x = st.x, y = st.y, vx = st.vx, vy = st.vy;
    const dt = 120;
    for (let i = 0; i < 2400; i++) {
      const r3 = Math.pow(x * x + y * y, 1.5);
      vx -= 0.5 * dt * LB.MU * x / r3; vy -= 0.5 * dt * LB.MU * y / r3;
      x += dt * vx; y += dt * vy;
      const r3b = Math.pow(x * x + y * y, 1.5);
      vx -= 0.5 * dt * LB.MU * x / r3b; vy -= 0.5 * dt * LB.MU * y / r3b;
      if (i % 4 === 0) pts.push([x / 1000, y / 1000]);
      if (Math.hypot(x, y) > 6e8) break;
    }
    return pts;
  }
  function renderTele() {
    const r = R.byId[R.selected];
    const sel = $('#teleSel');
    const ok = R.ranked.filter(x => x.feasible);
    if (sel.options.length !== ok.length || [...sel.options].some((o, i) => o.value !== ok[i].id)) {
      sel.textContent = '';
      ok.forEach(x => sel.append(h('option', { value: x.id, text: METHOD[x.id].short })));
    }
    if (!r || !r.feasible) { $('#teleName').textContent = ''; return; }
    sel.value = r.id;
    const name = $('#teleName');
    name.textContent = '';
    name.append(h('span', { class: 'sw ' + r.family }), METHOD[r.id].short);
    const tc = tAt(r.traj, play.p);
    const p = sampleAt(r.traj, tc);
    const evs = (r.events || []).filter(e => e.t <= tc + 1e-6);
    const ev = evs.length ? evs[evs.length - 1].label : '';
    $('#telePhase').textContent = (p.phase ? p.phase : '') + (ev && ev !== p.phase ? ' · ' + ev : '');
    $('#tT').textContent = F.clock(p.t);
    $('#tAlt').textContent = F.km(p.alt);
    $('#tDr').textContent = r.id === 'elevator' ? '0 km' : F.km(p.dr);
    $('#tV').textContent = F.speed(p.v);
    $('#tVr').textContent = r.id === 'elevator' ? F.speed(p.vrel) + ' climb' : F.speed(p.vrel);
    $('#tG').textContent = F.g(p.g);
    $('#tQ').textContent = p.q > 1 ? sig(p.q / 1000, 3) + ' kPa' : '0 kPa';
    $('#tM').textContent = p.m ? F.mass(p.m) : '–';
  }
  function setP(p) {
    play.p = Math.max(0, Math.min(1, p));
    $('#scrub').value = Math.round(play.p * 1000);
    $('#scrubOut').textContent = Math.round(play.p * 100) + '%';
    drawRange(); renderTele();
  }
  function startReplay() {
    stopReplay();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setP(1); return; }
    const t0 = Date.now(), dur = 9000;
    play.p = 0;
    $('#playBtn span').textContent = 'Pause';
    play.timer = setInterval(() => {
      const p = (Date.now() - t0) / dur;
      setP(p);
      if (p >= 1) stopReplay();
    }, 40); // setInterval, not rAF: keeps animating in hidden or zero-size previews
  }
  function stopReplay() {
    if (play.timer) clearInterval(play.timer);
    play.timer = null;
    $('#playBtn span').textContent = 'Replay';
  }
  function renderRangeLegend() {
    const box = $('#rangeLegend');
    box.textContent = '';
    R.ranked.filter(r => r.feasible).forEach(r => {
      const dash = DASH[r.id].length ? `border-top-style: ${DASH[r.id][0] > 3 ? 'dashed' : 'dotted'};` : '';
      const ln = h('i', { class: 'ln' });
      ln.setAttribute('style', `border-color: var(--fam-${r.family}); ${dash}`);
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(r.id === R.selected), onclick: () => select(r.id) }, h('span', {}, ln, ' ', METHOD[r.id].short));
      box.append(b);
    });
  }

  // ───────────────────────── SVG charts ─────────────────────────
  const tip = $('#tip');
  function showTip(e, build) {
    tip.textContent = '';
    build(tip);
    tip.hidden = false;
    const x = Math.min(window.innerWidth - tip.offsetWidth - 12, e.clientX + 14), y = Math.min(window.innerHeight - tip.offsetHeight - 12, e.clientY + 14);
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  const hideTip = () => { tip.hidden = true; };
  function decadeTicks(lo, hi) { const t = []; for (let d = Math.floor(lo); d <= Math.ceil(hi); d++) t.push(d); return t; }
  function barPath(x0, y, w, hgt) {
    const r = Math.min(4, w / 2, hgt / 2);
    if (w <= 0.5) return `M${x0},${y}h0.5v${hgt}h-0.5z`;
    return `M${x0},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${hgt - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - r}z`;
  }
  /* Horizontal bars, one series coloured by family, log or linear scale. rows: [{id, family, value}] */
  function barChart(host, rows, o) {
    host.textContent = '';
    if (!rows.length) { host.append(h('p', { class: 'hint', text: 'No feasible methods to compare.' })); return; }
    const W = Math.max(300, host.clientWidth || 480);
    const rowH = 22, labW = Math.min(150, W * 0.34), valW = 78, top = 6, axisH = 20;
    const plotW = W - labW - valW;
    const Hh = top + rows.length * rowH + axisH;
    const vals = rows.map(r => r.value).concat(o.limit ? [o.limit] : []);
    let lo, hi, X;
    if (o.log) {
      lo = Math.floor(Math.log10(Math.min(...vals))); hi = Math.ceil(Math.log10(Math.max(...vals)));
      if (hi === lo) hi++;
      lo = Math.min(lo, hi - 1);
      X = v => labW + (Math.log10(Math.max(v, Math.pow(10, lo))) - lo) / (hi - lo) * plotW;
    } else {
      lo = 0; hi = Math.max(...vals) * 1.05; X = v => labW + v / hi * plotW;
    }
    const svg = sv('svg', { viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-label': o.title });
    // grid + axis
    const ticks = o.log ? decadeTicks(lo, hi).map(d => Math.pow(10, d)) : [0, hi / 4, hi / 2, 3 * hi / 4].map(v => +v.toPrecision(2));
    ticks.forEach(v => {
      const x = Math.round(X(v)) + 0.5;
      svg.append(sv('line', { class: 'grid', x1: x, x2: x, y1: top - 2, y2: top + rows.length * rowH }));
      svg.append(sv('text', { class: 'ax', x, y: Hh - 6, 'text-anchor': 'middle' }, o.tickFmt ? o.tickFmt(v) : sig(v, 2)));
    });
    svg.append(sv('line', { class: 'base', x1: labW + 0.5, x2: labW + 0.5, y1: top - 2, y2: top + rows.length * rowH }));
    rows.forEach((r, i) => {
      const y = top + i * rowH, bh = 12, by = y + (rowH - bh) / 2;
      const x0 = labW, w = Math.max(1, X(r.value) - x0);
      const isSel = r.id === R.selected;
      const label = sv('text', { x: labW - 8, y: y + rowH / 2 + 4, 'text-anchor': 'end', style: isSel ? 'font-weight:600;fill:var(--ink)' : null }, METHOD[r.id].short);
      const bar = sv('path', { class: 'bar f-' + r.family, d: barPath(x0, by, w, bh) });
      const val = sv('text', { class: 'val', x: x0 + w + 6, y: y + rowH / 2 + 4 }, o.fmt(r.value));
      const hit = sv('rect', { x: 0, y, width: W, height: rowH, fill: 'transparent', tabindex: '0', style: 'cursor:pointer', 'aria-label': `${METHOD[r.id].name}: ${o.fmt(r.value)}` });
      hit.addEventListener('pointermove', e => showTip(e, t => { t.append(h('strong', { text: o.fmt(r.value) }), h('div', { class: 'row' }, h('span', { class: 'sw ' + r.family }), METHOD[r.id].name)); if (o.note) t.append(h('div', { class: 'row', text: o.note(r) })); }));
      hit.addEventListener('pointerleave', hideTip);
      hit.addEventListener('focus', e => { const b = hit.getBoundingClientRect(); showTip({ clientX: b.left + labW, clientY: b.bottom }, t => t.append(h('strong', { text: o.fmt(r.value) }), h('div', { class: 'row', text: METHOD[r.id].name }))); });
      hit.addEventListener('blur', hideTip);
      hit.addEventListener('click', () => select(r.id));
      svg.append(label, bar, val, hit);
    });
    if (o.limit) {
      const x = Math.round(X(o.limit)) + 0.5;
      svg.append(sv('line', { class: 'limit', x1: x, x2: x, y1: top - 4, y2: top + rows.length * rowH + 2 }));
      svg.append(sv('text', { class: 'ax', x: x - 4, y: top + rows.length * rowH + 14, 'text-anchor': 'end', style: 'fill:var(--critical-ink)' }, o.limitLabel));
    }
    host.append(svg);
  }
  function stackChart(host, rows, keys, o) {
    host.textContent = '';
    const W = Math.max(300, host.clientWidth || 600);
    const rowH = 22, labW = Math.min(150, W * 0.28), valW = 90, top = 4;
    const plotW = W - labW - valW;
    const Hh = top + rows.length * rowH + 6;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-label': o.title });
    rows.forEach((r, i) => {
      const y = top + i * rowH, bh = 12, by = y + (rowH - bh) / 2;
      const tot = keys.reduce((a, k) => a + (r.parts[k.k] || 0), 0) || 1;
      svg.append(sv('text', { x: labW - 8, y: y + rowH / 2 + 4, 'text-anchor': 'end', style: r.id === R.selected ? 'font-weight:600;fill:var(--ink)' : null }, METHOD[r.id].short));
      let x = labW;
      const segs = keys.filter(k => (r.parts[k.k] || 0) / tot > 0.002);
      segs.forEach((k, j) => {
        const w = (r.parts[k.k] / tot) * plotW - (j < segs.length - 1 ? 2 : 0);
        const seg = sv('rect', { class: 'bar f-' + k.k, x, y: by, width: Math.max(0.5, w), height: bh, rx: j === segs.length - 1 ? 3 : 0 });
        seg.addEventListener('pointermove', e => showTip(e, t => t.append(h('strong', { text: F.pct(r.parts[k.k] / tot) + ' · ' + F.ePerKg(r.parts[k.k]) }), h('div', { class: 'row' }, h('span', { class: 'sw ' + k.k }), k.label), h('div', { class: 'row', text: METHOD[r.id].name }))));
        seg.addEventListener('pointerleave', hideTip);
        seg.addEventListener('click', () => select(r.id));
        svg.append(seg);
        x += w + 2;
      });
      svg.append(sv('text', { class: 'val', x: labW + plotW + 8, y: y + rowH / 2 + 4 }, o.total(r)));
    });
    host.append(svg);
  }
  function renderCharts() {
    const box = $('#charts');
    box.textContent = '';
    const ok = R.results.filter(r => r.feasible);
    const asc = k => ok.slice().sort((a, b) => a[k] - b[k]);
    const mk = (title, sub, wide) => { const c = h('div', { class: 'chart' + (wide ? ' wide' : '') }, h('h3', { text: title }), h('p', { class: 'sub', text: sub })); const body = h('div'); c.append(body); box.append(c); return body; };
    const charts = [
      () => barChart(mk('Energy spent per kg delivered', 'All sources, including making the propellant. Lower is better.'), asc('energyPerKg').map(r => ({ id: r.id, family: r.family, value: r.energyPerKg / 1e6 })), { log: true, title: 'Energy per kg', fmt: v => sig(v, 3) + ' MJ', tickFmt: v => sig(v, 1), note: r => 'Efficiency ' + F.pct(R.byId[r.id].eff) }),
      () => barChart(mk('Cost per kg delivered', 'Hardware, propellant, power, operations and amortized infrastructure. Lower is better.'), asc('costPerKg').map(r => ({ id: r.id, family: r.family, value: r.costPerKg })), { log: true, title: 'Cost per kg', fmt: v => F.money(v), tickFmt: v => F.money(v) }),
      () => barChart(mk('Launch mass per kg of payload', 'Everything that leaves the ground, launcher hardware excluded. Lower is better.'), asc('launchMass').map(r => ({ id: r.id, family: r.family, value: r.launchMass / R.ctx.payload.mass })), { log: true, title: 'Mass ratio', fmt: v => sig(v, 3) + ' kg', tickFmt: v => sig(v, 1) }),
      () => barChart(mk('Peak acceleration on the payload', 'Launch, drag and burn loads. The red line is what your payload survives.'), asc('peakG').map(r => ({ id: r.id, family: r.family, value: Math.max(1, r.peakG) })), { log: true, title: 'Peak g', fmt: v => F.g(v), tickFmt: v => nf(v), limit: R.ctx.payload.gTol, limitLabel: 'limit ' + nf(R.ctx.payload.gTol) + ' g' }),
      () => barChart(mk('CO₂ per kg delivered', `Combustion, propellant production and grid power at ${S.econ.gridCO2} kg/kWh. Lower is better.`), asc('co2PerKg').map(r => ({ id: r.id, family: r.family, value: Math.max(0.01, r.co2PerKg) })), { log: true, title: 'CO₂ per kg', fmt: v => sig(v, 3) + ' kg', tickFmt: v => sig(v, 1) }),
      () => barChart(mk('Time to destination', 'From ignition or release to arrival, including the coast to the target.'), asc('timeToDest').map(r => ({ id: r.id, family: r.family, value: Math.max(1, r.timeToDest) })), { log: true, title: 'Time', fmt: v => F.time(v), tickFmt: v => F.time(v) }),
    ];
    charts.forEach(f => f());
    // energy source mix
    const body = mk('Where the energy comes from', 'Share of the total energy per launch. Guns, tubes and elevators move the energy off the vehicle and onto the grid.', true);
    const keys = [{ k: 'onboard', label: 'Onboard propellant' }, { k: 'ground', label: 'Grid power & ground fuel' }, { k: 'space', label: 'Solar power in orbit' }, { k: 'made', label: 'Making the propellant' }];
    const lg = h('div', { class: 'legend', style: { margin: '0 0 6px' } });
    keys.forEach(k => lg.append(h('span', {}, h('span', { class: 'sw ' + k.k }), k.label)));
    body.before(lg);
    stackChart(body, asc('energyPerKg').map(r => ({ id: r.id, parts: { onboard: r.E.onboard / R.ctx.payload.mass, ground: r.E.ground / R.ctx.payload.mass, space: r.E.space / R.ctx.payload.mass, made: r.E.made / R.ctx.payload.mass } })), keys, { title: 'Energy mix', total: r => F.ePerKg(R.byId[r.id].energyPerKg) });
    // family legend
    const fl = $('#famLegend');
    fl.textContent = '';
    LB.FAMILIES.forEach(f => fl.append(h('span', {}, h('span', { class: 'sw ' + f.id }), f.name)));
  }

  // ───────────────────────── crossover sweep ─────────────────────────
  const SWEEP_X = {
    mass: { label: 'Payload mass', vals: [1, 3, 10, 30, 100, 300, 1000, 3000, 10000, 30000, 100000], fmt: v => F.mass(v), axis: v => v < 1000 ? v + ' kg' : v / 1000 + ' t', apply: (c, v) => { c.payload.mass = v; } },
    perYear: { label: 'Launches per year', vals: [1, 3, 10, 30, 100, 300, 1000, 3000, 10000], fmt: v => nf(v) + '/yr', axis: v => v >= 1000 ? v / 1000 + 'k' : String(v), apply: (c, v) => { c.econ.perYear = v; } },
    gTol: { label: 'Survivable acceleration', vals: [3, 10, 30, 100, 300, 1000, 3000, 10000, 50000], fmt: v => nf(v) + ' g', axis: v => (v >= 1000 ? v / 1000 + 'k' : v) + ' g', apply: (c, v) => { c.payload.gTol = v; } },
  };
  const SWEEP_Y = {
    costPerKg: { label: 'Cost per kg', get: r => r.costPerKg, fmt: v => F.money(v) },
    energyPerKg: { label: 'Energy per kg', get: r => r.energyPerKg, fmt: v => F.ePerKg(v) },
    massRatio: { label: 'Launch mass per kg', get: (r, c) => r.launchMass / c.payload.mass, fmt: v => sig(v, 3) + ' kg/kg' },
    co2PerKg: { label: 'CO₂ per kg', get: r => r.co2PerKg, fmt: v => sig(v, 3) + ' kg' },
  };
  function sweepKey() { return JSON.stringify([sweep.x, S.payload, S.mission, S.econ, S.enabled, S.params]); }
  async function runSweep() {
    const myId = ++sweep.runId;
    const key = sweepKey();
    const X = SWEEP_X[sweep.x];
    const ids = LB.METHODS.filter(m => S.enabled[m.id]).map(m => m.id);
    const data = { x: sweep.x, vals: X.vals, rows: [] };
    sweep.running = true;
    $('#sweepBtn').disabled = true;
    let n = 0;
    const total = X.vals.length * ids.length;
    for (const v of X.vals) {
      const c = { payload: Object.assign({}, S.payload), mission: Object.assign({}, S.mission), econ: Object.assign({}, S.econ), fast: true };
      X.apply(c, v);
      const ctx = LB.makeContext(c);
      const row = { v, ctx, res: {} };
      for (const id of ids) {
        $('#sweepState').textContent = `Computing ${++n} of ${total}`;
        await tick();
        if (myId !== sweep.runId) { $('#sweepBtn').disabled = false; return; }
        row.res[id] = LB.runMethod(id, ctx, S.params[id]);
      }
      data.rows.push(row);
      if (data.rows.length > 1) { sweep.data = data; renderSweep(); }
    }
    sweep.data = data; sweep.key = key; sweep.running = false;
    $('#sweepBtn').disabled = false;
    $('#sweepState').textContent = '';
    renderSweep();
  }
  function renderSweep() {
    const box = $('#sweepChart'), strip = $('#winnerStrip'), leg = $('#sweepLegend');
    box.textContent = ''; strip.textContent = ''; leg.textContent = '';
    const d = sweep.data;
    $('#sweepSub').textContent = `The same trials rerun across a range of ${SWEEP_X[sweep.x].label.toLowerCase()} with everything else held at your settings. The strip shows the winner on ${SWEEP_Y[sweep.y].label.toLowerCase()} at each point.`;
    if (!d || d.x !== sweep.x) { box.append(h('p', { class: 'hint', text: sweep.runId ? 'Running the sweep…' : 'Run the sweep to see where each method wins.' })); return; }
    const Y = SWEEP_Y[sweep.y], X = SWEEP_X[d.x];
    const ids = Object.keys(d.rows[0].res);
    const series = ids.map(id => ({ id, family: METHOD[id].family, pts: d.rows.map(row => { const r = row.res[id]; return r && r.feasible ? [row.v, Y.get(r, row.ctx)] : null; }) }));
    // winners per x
    const winners = d.rows.map((row, i) => {
      let best = null;
      for (const s of series) { const p = s.pts[i]; if (p && p[1] > 0 && (!best || p[1] < best.y)) best = { id: s.id, y: p[1] }; }
      return best;
    });
    // highlight: anything that wins somewhere, plus the selected method
    const hi = new Set(winners.filter(Boolean).map(w => w.id));
    if (R.selected) hi.add(R.selected);
    // strip
    let i = 0;
    while (i < winners.length) {
      let j = i;
      while (j + 1 < winners.length && winners[j + 1] && winners[i] && winners[j + 1].id === winners[i].id) j++;
      const w = winners[i];
      const seg = h('div', { style: { flex: String(j - i + 1), background: w ? `var(--fam-${METHOD[w.id].family})` : 'var(--rule)' }, title: w ? `${METHOD[w.id].name}: ${X.fmt(d.rows[i].v)}${j > i ? ' to ' + X.fmt(d.rows[j].v) : ''}` : 'Nothing reaches the target' }, h('span', { text: w ? METHOD[w.id].short : 'none' }));
      strip.append(seg);
      i = j + 1;
    }
    // chart
    const W = Math.max(320, box.clientWidth || 800), H = 320, m = { l: 64, r: 120, t: 10, b: 34 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const ys = series.flatMap(s => s.pts.filter(Boolean).map(p => p[1])).filter(v => v > 0);
    if (!ys.length) return;
    let ylo = Math.floor(Math.log10(Math.min(...ys))), yhi = Math.ceil(Math.log10(Math.max(...ys)));
    if (yhi === ylo) yhi++;
    const xlo = Math.log10(X.vals[0]), xhi = Math.log10(X.vals[X.vals.length - 1]);
    const PX = v => m.l + (Math.log10(v) - xlo) / (xhi - xlo) * pw, PY = v => m.t + ph - (Math.log10(v) - ylo) / (yhi - ylo) * ph;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${Y.label} versus ${X.label}` });
    for (let dd = ylo; dd <= yhi; dd++) {
      const y = Math.round(PY(Math.pow(10, dd))) + 0.5;
      svg.append(sv('line', { class: 'grid', x1: m.l, x2: m.l + pw, y1: y, y2: y }), sv('text', { class: 'ax', x: m.l - 6, y: y + 3, 'text-anchor': 'end' }, Y.fmt(Math.pow(10, dd))));
    }
    const every = pw / X.vals.length < 56 ? 2 : 1;
    X.vals.forEach((v, k) => {
      const x = Math.round(PX(v)) + 0.5;
      svg.append(sv('line', { class: 'grid', x1: x, x2: x, y1: m.t, y2: m.t + ph }));
      if (k % every === 0) svg.append(sv('text', { class: 'ax', x, y: H - 14, 'text-anchor': 'middle' }, X.axis(v)));
    });
    svg.append(sv('text', { x: m.l + pw / 2, y: H - 1, 'text-anchor': 'middle' }, X.label));
    const ends = [];
    const ordered = series.slice().sort((a, b) => hi.has(a.id) - hi.has(b.id));
    for (const s of ordered) {
      const on = hi.has(s.id);
      let dpath = '', pen = false;
      s.pts.forEach(p => { if (!p || !(p[1] > 0)) { pen = false; return; } dpath += (pen ? 'L' : 'M') + PX(p[0]).toFixed(1) + ',' + PY(p[1]).toFixed(1); pen = true; });
      if (!dpath) continue;
      const path = sv('path', { d: dpath, fill: 'none', class: 's-' + s.family, 'stroke-width': on ? 2.2 : 1, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: on ? 1 : 0.28, 'stroke-dasharray': DASH[s.id].join(' ') || null });
      svg.append(path);
      if (on) {
        s.pts.forEach(p => { if (p && p[1] > 0) svg.append(sv('circle', { cx: PX(p[0]), cy: PY(p[1]), r: 3, class: 'f-' + s.family, stroke: 'var(--panel)', 'stroke-width': 1.5 })); });
        const lastP = [...s.pts].reverse().find(p => p && p[1] > 0);
        if (lastP) ends.push({ id: s.id, x: PX(lastP[0]), y: PY(lastP[1]) });
      }
    }
    // end labels with simple collision nudging + leader lines
    ends.sort((a, b) => a.y - b.y);
    for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 13) ends[k].ly = (ends[k - 1].ly || ends[k - 1].y) + 13;
    ends.forEach(e => {
      const ly = e.ly || e.y;
      if (Math.abs(ly - e.y) > 1) svg.append(sv('line', { x1: e.x + 4, y1: e.y, x2: m.l + pw + 6, y2: ly, class: 'grid' }));
      svg.append(sv('text', { x: m.l + pw + 8, y: ly + 4 }, METHOD[e.id].short));
    });
    // crosshair
    const cross = sv('line', { class: 'base', y1: m.t, y2: m.t + ph, visibility: 'hidden' });
    const hit = sv('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' });
    svg.append(cross, hit);
    hit.addEventListener('pointermove', e => {
      const b = svg.getBoundingClientRect(), xs = (e.clientX - b.left) * (W / b.width);
      let bi = 0, bd = Infinity;
      d.rows.forEach((row, k) => { const dx = Math.abs(PX(row.v) - xs); if (dx < bd) { bd = dx; bi = k; } });
      const x = PX(d.rows[bi].v);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      showTip(e, t => {
        t.append(h('strong', { text: X.fmt(d.rows[bi].v) }));
        series.map(s => ({ s, p: s.pts[bi] })).filter(o => o.p).sort((a, b) => a.p[1] - b.p[1]).forEach(o => {
          const key = h('span', { class: 'key' }); key.style.borderColor = `var(--fam-${o.s.family})`;
          t.append(h('div', { class: 'row' }, key, METHOD[o.s.id].short, h('b', { text: Y.fmt(o.p[1]) })));
        });
        const none = series.filter(s => !s.pts[bi]).length;
        if (none) t.append(h('div', { class: 'row', text: `${none} not viable here` }));
      });
    });
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
    box.append(svg);
    // legend: every series with its line key
    series.forEach(s => {
      const k = h('i', { class: 'ln' });
      k.setAttribute('style', `border-color: var(--fam-${s.family}); ${DASH[s.id].length ? 'border-top-style:' + (DASH[s.id][0] > 3 ? 'dashed' : 'dotted') + ';' : ''} opacity: ${hi.has(s.id) ? 1 : 0.4}`);
      leg.append(h('span', {}, k, METHOD[s.id].short));
    });
  }

  // ───────────────────────── dossier ─────────────────────────
  const ICON = {
    fail: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="var(--critical)"/><path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
    warn: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2 15.2 14H.8z" fill="var(--warning)"/><path d="M8 5.5v4" stroke="#1a1a19" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.8" r="0.9" fill="#1a1a19"/></svg>',
    info: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="var(--ink-2)" stroke-width="1.3"/><path d="M8 7v4.5" stroke="var(--ink-2)" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="4.8" r="0.9" fill="var(--ink-2)"/></svg>',
  };
  const iconEl = k => { const s = h('span'); s.innerHTML = ICON[k]; return s.firstChild; };
  function kv(pairs, totalLast) {
    const dl = h('dl', { class: 'kv' });
    pairs.forEach((p, i) => { const tot = totalLast && i === pairs.length - 1; dl.append(h('dt', { class: tot ? 'tot' : null, text: p[0] }), h('dd', { class: tot ? 'tot' : null, text: p[1] })); });
    return dl;
  }
  function stackBar(parts, cls) {
    const tot = parts.reduce((a, p) => a + p.v, 0) || 1;
    const b = h('div', { class: 'stackbar', role: 'img', 'aria-label': parts.map(p => `${p.label} ${F.pct(p.v / tot)}`).join(', ') });
    parts.filter(p => p.v / tot > 0.003).forEach((p, i) => {
      const seg = h('i', { title: `${p.label}: ${F.pct(p.v / tot)}` });
      seg.style.flex = String(p.v / tot);
      seg.style.background = p.color || `color-mix(in srgb, var(--fam-${cls}) ${Math.max(25, 100 - i * 18)}%, var(--panel))`;
      b.append(seg);
    });
    return b;
  }
  function specifics(r) {
    const x = r.extra || {}, out = [];
    if (x.muzzle) {
      out.push(['Exit speed', F.speed(x.muzzle) + (x.limitedBy === 'g' ? ' (g-limited)' : '')], ['Exit elevation', x.elev.toFixed(1) + '°'], ['Launch load', F.g(x.gLaunch)],
        ['Speed lost to drag', F.dv(x.dragLossAtmo)], ['Projectile diameter', x.diam ? sig(x.diam, 2) + ' m' : '–'], ['Peak nose heating', sig(r.peakHeat / 1e6, 3) + ' MW/m²'],
        ['Onboard stages', String(x.nStages)], ['Launcher energy per shot', F.energy(x.Ein)]);
      if (x.armRatio) out.push(['Spin-arm mass / projectile', sig(x.armRatio, 3) + '×']);
    }
    if (x.carrier) out.push(['Carrier', x.carrier.name], ['Jet fuel per sortie', F.mass(x.carrier.fuel)]);
    if (x.helium) out.push(['Helium', F.mass(x.helium)], ['Balloon envelope', F.mass(x.envelope)]);
    if (x.Pbeam) out.push(['Beam power at vehicle', F.power(x.Pbeam)], ['Beam energy per launch', F.energy(x.Ebeam)]);
    if (x.Mfac) out.push(['Catch altitude', F.km(x.catchAlt / 1000)], ['Catch speed (inertial)', F.speed(x.vCatch)], ['Release speed', F.speed(x.vRelease)], ['Release after', x.releaseDeg + '° of swing'],
      ['Kick after release', F.dv(x.kickDv)], ['Facility mass', F.mass(x.Mfac)], ['Tether / stack mass', sig(x.tetherRatio, 3) + '×'], ['Reboost energy per catch', F.energy(x.Ere)]);
    if (x.taper) out.push(['Ribbon taper ratio', x.taper > 1e6 ? x.taper.toExponential(1) : sig(x.taper, 3)], ['Release altitude', F.km((x.rRel - LB.RE) / 1000)], ['Release speed', F.speed(x.vRel)],
      ['Kick at perigee', F.dv(x.kickDv)], ['Climb time', F.time(x.climbT)], ['Ribbon mass', F.mass(x.ribbon)], ['Counterweight', F.mass(x.counterweight)]);
    if (r.vehicle && r.vehicle.stages && !x.muzzle) r.vehicle.stages.forEach((s, i) => out.push([`Stage ${i + 1}`, `${F.mass(s.prop)} propellant, ε ${(s.eps || 0).toFixed(3)}`]));
    if (r.gp != null && r.vehicle && !x.muzzle && !x.Mfac) out.push([r.id === 'airlaunch' ? 'Pull-up attitude' : 'Pitch kick', r.gp + '°']);
    if (x.departure) out.push(['Departure stage', `${F.mass(x.departure.total)} for ${F.dv(R.ctx.D.dvDep)}`]);
    return out;
  }
  function renderDossier() {
    const box = $('#dossier');
    box.textContent = '';
    const r = R.byId[R.selected] || R.ranked[0];
    if (!r) return;
    const M = METHOD[r.id];
    const status = !r.feasible ? h('span', { class: 'pill fail', text: 'Not viable for this payload' }) : r.issues.some(i => i.level === 'warn') ? h('span', { class: 'pill warn', text: 'Feasible, with flags' }) : h('span', { class: 'pill ok', text: 'Feasible' });
    const rank = R.ranked.filter(x => x.feasible).findIndex(x => x.id === r.id);
    box.append(h('div', { class: 'dossier-head' },
      h('div', {}, h('p', { class: 'eyebrow' }, h('span', { class: 'sw ' + r.family, style: { marginRight: '6px' } }), `Dossier · ${FAM[r.family].name}`),
        h('h2', { class: 'dossier-title', text: r.name }), h('p', { class: 'dossier-blurb', text: M.blurb })),
      h('div', { style: { display: 'grid', gap: '6px', justifyItems: 'end' } }, status, h('span', { class: 'trl', text: `TRL ${r.trl}${rank >= 0 ? ' · rank ' + (rank + 1) : ''}` }))));
    if (r.feasible) {
      const tiles = [
        ['Launch mass', F.mass(r.launchMass), F.pct(r.payloadFraction) + ' payload'],
        ['Energy per kg', F.ePerKg(r.energyPerKg), F.pct(r.eff) + ' efficient'],
        ['Cost per kg', F.money(r.costPerKg), F.money(r.cost.total) + ' per launch'],
        ['Peak load', F.g(r.peakG), 'limit ' + nf(R.ctx.payload.gTol) + ' g'],
        ['CO₂ per kg', F.co2(r.co2PerKg), F.mass(r.co2) + ' per launch'],
        ['Time to destination', F.time(r.timeToDest), 'readiness TRL ' + r.trl],
      ];
      box.append(h('div', { class: 'tiles' }, tiles.map(t => h('div', { class: 'tile' }, h('span', { class: 'lbl', text: t[0] }), h('div', { class: 'big', text: t[1] }), h('span', { class: 'note', text: t[2] })))));
    }
    const grid = h('div', { class: 'dossier-grid' });
    // flags
    const flags = h('section', {}, h('h3', { text: r.feasible ? 'Flags and notes' : 'Why it cannot do this job' }));
    const ul = h('ul', { class: 'issues' });
    r.issues.forEach(i => ul.append(h('li', {}, iconEl(i.level === 'fail' ? 'fail' : 'warn'), h('span', { text: i.text }))));
    (r.notes || []).forEach(n => ul.append(h('li', {}, iconEl('info'), h('span', { text: n }))));
    if (!ul.children.length) ul.append(h('li', {}, iconEl('info'), h('span', { text: 'No flags. The flight closed with the payload inside its limits.' })));
    flags.append(ul);
    // how it works
    const how = h('section', { class: 'how' }, h('h3', { text: 'How it works' }), M.how.map(p => h('p', { text: p })));
    if (!r.feasible) { grid.append(flags, how); box.append(grid); return; }
    // mass
    const masses = r.masses.slice().sort((a, b) => b.kg - a.kg);
    const massSec = h('section', {}, h('h3', { text: 'Mass at launch' }),
      stackBar(masses.map(m => ({ label: m.label, v: m.kg })), r.family),
      kv(masses.map(m => [m.label, F.mass(m.kg)]).concat([['Total leaving the ground', F.mass(r.launchMass)]]), true));
    // Δv ledger
    const d = r.dv || {};
    const ledger = [];
    if (r.id === 'elevator') {
      ledger.push(['Ground speed at the anchor', F.speed(d.rotation)], ['Speed at release, given by the ribbon', F.speed(d.final)], ['Climb energy per kg', sig(r.extra.dPhi / 1e6, 3) + ' MJ/kg'], ['Kick burn', F.dv(d.kick)]);
    } else {
      ledger.push(['Earth rotation at the site', F.dv(R.ctx.omega * LB.RE)]);
      if (d.assist) ledger.push([r.id === 'rotovator' ? 'Added by the tether swing' : r.extra && r.extra.muzzle ? 'Given by the launcher' : r.id === 'airlaunch' ? 'Carrier aircraft speed' : 'Assist', F.dv(d.assist)]);
      ledger.push(['Gravity loss', F.dv(d.gravity)], ['Drag loss', F.dv(d.drag)], ['Steering loss', F.dv(d.steering)], ['Circularization trim', F.dv(d.trim)]);
      if (d.kick) ledger.push(['Kick after tether release', F.dv(d.kick)]);
      if (r.extra && r.extra.departure) ledger.push(['Departure stage', F.dv(R.ctx.D.dvDep)]);
      ledger.push(['Onboard propulsion, total', F.dv(d.onboard + (d.kick || 0) + (r.extra && r.extra.departure ? R.ctx.D.dvDep : 0))]);
    }
    const dvSec = h('section', {}, h('h3', { text: 'Δv ledger' }), kv(ledger, true),
      h('p', { class: 'hint', text: 'Losses are measured along the flown path in the inertial frame: Δv onboard = Δ|v| + gravity + drag + steering.' }));
    // energy
    const E = r.E, mp = R.ctx.payload.mass;
    const eSec = h('section', {}, h('h3', { text: 'Energy per launch' }),
      stackBar([{ label: 'Onboard propellant', v: E.onboard, color: 'var(--src-onboard)' }, { label: 'Grid & ground fuel', v: E.ground, color: 'var(--src-ground)' }, { label: 'Solar in orbit', v: E.space, color: 'var(--src-space)' }, { label: 'Making propellant', v: E.made, color: 'var(--src-made)' }]),
      kv([['Onboard propellant', F.energy(E.onboard)], ['Grid power & ground fuel', F.energy(E.ground)], ['Solar power in orbit', F.energy(E.space)], ['Making the propellant', F.energy(E.made)],
        ['Useful energy given to the payload', F.energy(r.useful)], ['Total spent', F.energy(E.total) + ' · ' + F.pct(r.eff) + ' efficient']], true),
      h('p', { class: 'hint', text: `Per kilogram of payload: ${F.ePerKg(E.total / mp)} spent for ${F.ePerKg(r.useful / mp)} of orbital energy.` }));
    // cost
    const c = r.cost;
    const cSec = h('section', {}, h('h3', { text: 'Cost per launch' }),
      kv([['Vehicle & projectile hardware', F.money(c.hardware)], ['Propellant & gases', F.money(c.propellant)], ['Electricity', F.money(c.energy)], ['Operations & refurbishment', F.money(c.ops)],
        ['Consumables (rails, membranes)', F.money(c.consumables)], ['Infrastructure, amortized', F.money(c.infra)], ['Total per launch', F.money(c.total)]], true),
      h('p', { class: 'hint', text: r.infra.items.map(it => `${it.label}: ${F.money(it.capex)}${it.units > 1 ? ' (' + it.units + ' sites)' : ''}`).join('. ') + `. Spread over ${nf(S.econ.perYear * S.econ.years)} launches.` }));
    // timeline
    const evs = (r.events || []).slice().sort((a, b) => a.t - b.t);
    const tl = h('ol', { class: 'timeline' });
    evs.forEach(e => tl.append(h('li', {}, h('time', { text: F.clock(e.t) }), h('span', { text: e.label }))));
    const tSec = h('section', {}, h('h3', { text: 'Flight timeline' }), tl);
    const spSec = h('section', {}, h('h3', { text: 'Key numbers' }), kv(specifics(r)));
    grid.append(massSec, dvSec, eSec, cSec, tSec, spSec, flags, how);
    box.append(grid);
  }

  // ───────────────────────── render all ─────────────────────────
  function renderAll() {
    renderVerdict();
    renderBoard();
    renderRangeLegend();
    renderTele();
    drawRange();
    renderCharts();
    renderDossier();
  }

  // ───────────────────────── wiring ─────────────────────────
  function wire() {
    $('#runBtn').addEventListener('click', runTrials);
    $('#playBtn').addEventListener('click', () => { if (play.timer) stopReplay(); else startReplay(); });
    $('#scrub').addEventListener('input', e => { stopReplay(); setP(+e.target.value / 1000); });
    $('#teleSel').addEventListener('change', e => select(e.target.value));
    const tabs = { ascent: $('#tabAscent'), orbit: $('#tabOrbit') };
    for (const k in tabs) tabs[k].addEventListener('click', () => { play.view = k; for (const j in tabs) tabs[j].setAttribute('aria-selected', String(j === k)); drawRange(); });
    $('#sweepX').addEventListener('change', e => { sweep.x = e.target.value; sweep.data = null; renderSweep(); runSweep(); });
    $('#sweepY').addEventListener('change', e => { sweep.y = e.target.value; renderSweep(); });
    $('#sweepBtn').addEventListener('click', runSweep);
    let rt = null;
    const reflow = () => { clearTimeout(rt); rt = setTimeout(() => { if (!R.results.length) return; drawRange(); renderCharts(); renderSweep(); }, 120); };
    window.addEventListener('resize', reflow);
    if (window.ResizeObserver) new ResizeObserver(reflow).observe($('.record'));
    const mq = matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', () => drawRange());
    new MutationObserver(() => drawRange()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // On narrow screens the verdict moves above the input rail so the answer comes first.
  const mqNarrow = matchMedia('(max-width: 1000px)');
  function placeVerdict() {
    const v = $('#verdict');
    if (mqNarrow.matches) { if (v.parentElement !== $('.bench')) $('.bench').insertBefore(v, $('.rail')); }
    else if (v.parentElement !== $('.record')) $('.record').insertBefore(v, $('.record').firstChild);
  }
  if (mqNarrow.addEventListener) mqNarrow.addEventListener('change', placeVerdict);
  placeVerdict();

  buildRail();
  wire();
  $('#taSerial').textContent = `${F.mass(S.payload.mass)} · ${nf(S.payload.gTol)} g`;
  runTrials();

  // test hook for scripted checks
  window.__LAUNCHBENCH = { S, R, sweep, play, runTrials, runSweep, select, setP, F };
})();
