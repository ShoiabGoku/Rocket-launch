/* LAUNCHBENCH physics engine.
 * One payload, many ways to space. Every method is flown or solved from first principles:
 * 2-D point-mass trajectories (inverse-square gravity, US-1976 atmosphere, rotating air,
 * Mach-dependent drag, altitude-dependent Isp), closed-loop ascent guidance, Tsiolkovsky
 * stage sizing iterated against the simulated losses, Sutton–Graves heating, Hoyt/Moravec
 * tapered-tether mass ratios, and space-elevator effective-potential energetics.
 * UMD: window.LB in the browser, module.exports in Node (test/validate.js). No DOM access. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LB = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────────────────────── constants ─────────────────────────
  const MU = 3.986004418e14, RE = 6378137, OMEGA = 7.2921159e-5, G0 = 9.80665, P0 = 101325;
  const R_GEO = Math.cbrt(MU / (OMEGA * OMEGA));
  const R_MOON = 384400e3;
  const HOUR = 3600, DAY = 86400, YEAR = 365.25 * DAY;
  const D2R = Math.PI / 180;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  // ───────────────────────── atmosphere (US Standard 1976) ─────────────────────────
  const LAYERS = [[0, 288.15, -6.5, 101325], [11, 216.65, 0, 22632.06], [20, 216.65, 1, 5474.889],
    [32, 228.65, 2.8, 868.0187], [47, 270.65, 0, 110.9063], [51, 270.65, -2.8, 66.93887], [71, 214.65, -2, 3.956420]];
  const GMR = 34.163195; // g0·M/R* in K/km
  function us76(zm) {
    const z = zm / 1000, H = 6356.766 * z / (6356.766 + z);
    let i = LAYERS.length - 1;
    while (i > 0 && H < LAYERS[i][0]) i--;
    const Hb = LAYERS[i][0], Tb = LAYERS[i][1], L = LAYERS[i][2], Pb = LAYERS[i][3];
    const T = Tb + L * (H - Hb);
    const p = L === 0 ? Pb * Math.exp(-GMR * (H - Hb) / Tb) : Pb * Math.pow(Tb / T, GMR / L);
    return { T, p, rho: p / (287.053 * T) };
  }
  // thermosphere densities from the US-1976 tables (km, kg/m³)
  const HI = [[86, 6.958e-6], [90, 3.416e-6], [100, 5.604e-7], [110, 9.708e-8], [120, 2.222e-8], [130, 8.152e-9],
    [140, 3.831e-9], [150, 2.076e-9], [160, 1.233e-9], [180, 5.194e-10], [200, 2.541e-10], [250, 6.073e-11],
    [300, 1.916e-11], [350, 7.014e-12], [400, 2.803e-12], [450, 1.184e-12], [500, 5.215e-13], [600, 1.137e-13],
    [700, 3.070e-14], [800, 1.136e-14], [900, 5.759e-15], [1000, 3.561e-15]];
  const TAB_DZ = 100, TAB_N = 861; // 0–86 km every 100 m
  const tLnRho = new Float64Array(TAB_N), tP = new Float64Array(TAB_N), tA = new Float64Array(TAB_N);
  for (let i = 0; i < TAB_N; i++) {
    const s = us76(i * TAB_DZ);
    tLnRho[i] = Math.log(s.rho); tP[i] = s.p; tA[i] = Math.sqrt(1.4 * 287.053 * s.T);
  }
  const HI_LN = HI.map(r => Math.log(r[1]));
  const ATM = { rho: 0, p: 0, a: 300 };
  function atm(h) {
    if (h < 0) h = 0;
    if (h < 86000) {
      const f = h / TAB_DZ, i = Math.min(TAB_N - 2, f | 0), u = f - i;
      ATM.rho = Math.exp(tLnRho[i] + u * (tLnRho[i + 1] - tLnRho[i]));
      ATM.p = tP[i] + u * (tP[i + 1] - tP[i]);
      ATM.a = tA[i] + u * (tA[i + 1] - tA[i]);
    } else {
      const km = h / 1000;
      let j = 0;
      while (j < HI.length - 2 && km > HI[j + 1][0]) j++;
      const lr = HI_LN[j] + (HI_LN[j + 1] - HI_LN[j]) * (km - HI[j][0]) / (HI[j + 1][0] - HI[j][0]);
      ATM.rho = Math.exp(lr); ATM.p = ATM.rho * 287.053 * 220; ATM.a = 290;
    }
    return ATM;
  }

  // ───────────────────────── aerodynamics ─────────────────────────
  // Cd vs Mach. Rocket: blunt-nosed launch vehicle. Slender: L/D≈8 gun-launched projectile with a small nose radius.
  const CD_ROCKET = [[0, 0.30], [0.6, 0.30], [0.8, 0.36], [1.0, 0.55], [1.2, 0.60], [1.5, 0.52], [2, 0.45], [3, 0.36], [5, 0.28], [10, 0.25], [50, 0.25]];
  const CD_SLENDER = [[0, 0.12], [0.8, 0.13], [1.0, 0.22], [1.2, 0.20], [1.5, 0.16], [3, 0.11], [5, 0.09], [10, 0.08], [50, 0.08]];
  function lerpTab(tab, x) {
    if (x <= tab[0][0]) return tab[0][1];
    for (let i = 1; i < tab.length; i++) {
      if (x <= tab[i][0]) {
        const a = tab[i - 1], b = tab[i];
        return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
      }
    }
    return tab[tab.length - 1][1];
  }
  const SUTTON_GRAVES = 1.7415e-4; // Earth air, SI: q̇ = k·sqrt(ρ/rn)·v³

  // ───────────────────────── orbital mechanics ─────────────────────────
  const vCirc = r => Math.sqrt(MU / r);
  function elems(x, y, vx, vy) {
    const r = Math.hypot(x, y), v2 = vx * vx + vy * vy, eps = v2 / 2 - MU / r, h = x * vy - y * vx;
    const e = Math.sqrt(Math.max(0, 1 + 2 * eps * h * h / (MU * MU)));
    const p = h * h / MU, rp = p / (1 + e);
    const ra = (eps < 0 && e < 1) ? p / (1 - e) : Infinity;
    const a = eps < 0 ? -MU / (2 * eps) : Infinity;
    return { r, v: Math.sqrt(v2), eps, h, e, p, rp, ra, a, vr: (x * vx + y * vy) / r };
  }
  const speedAt = (eps, r) => Math.sqrt(Math.max(0, 2 * (eps + MU / r)));
  const epsOf = (r1, r2) => -MU / (r1 + r2);
  // Two-impulse coplanar transfer from an orbit (rp, ra, eps) to a circular orbit of radius rt.
  function dvToCircular(rp, ra, eps, rt) {
    const vc = vCirc(rt);
    const eA = epsOf(rp, rt);
    let best = Math.abs(speedAt(eps, rp) - speedAt(eA, rp)) + Math.abs(vc - speedAt(eA, rt));
    if (isFinite(ra)) {
      const eB = epsOf(ra, rt);
      best = Math.min(best, Math.abs(speedAt(eps, ra) - speedAt(eB, ra)) + Math.abs(vc - speedAt(eB, rt)));
    }
    return best;
  }
  // From an orbit (rp, ra) to circular GEO with the plane change (= launch latitude) folded into the apogee burn.
  function dvToGEO(rp, ra, eps, lat) {
    const eT = epsOf(rp, R_GEO);
    const d1 = Math.abs(speedAt(eps, rp) - speedAt(eT, rp));
    const va = speedAt(eT, R_GEO), vg = vCirc(R_GEO);
    return d1 + Math.sqrt(va * va + vg * vg - 2 * va * vg * Math.cos(lat));
  }
  function timeToApo(el) {
    if (!(el.eps < 0) || el.e < 1e-7) return 0;
    const a = el.a, e = el.e, n = Math.sqrt(MU / (a * a * a));
    const cosE = clamp((1 - el.r / a) / e, -1, 1);
    let E = Math.acos(cosE);
    if (el.vr < 0) E = 2 * Math.PI - E;
    const M = E - e * Math.sin(E);
    let dt = (Math.PI - M) / n;
    if (dt < 0) dt += 2 * Math.PI / n;
    return dt;
  }
  // Time to the apoapsis that is about to happen (or 0 if we are just past it).
  function timeToApoNear(el) {
    if (!(el.eps < 0)) return 0;
    const T = 2 * Math.PI * Math.sqrt(el.a * el.a * el.a / MU), t = timeToApo(el);
    return t > 0.5 * T ? 0 : t;
  }
  // Analytic two-body propagation of an elliptic, prograde state by dt seconds (used for recorded coasts).
  function keplerPropagate(x, y, vx, vy, dt) {
    const r = Math.hypot(x, y), v2 = vx * vx + vy * vy, rv = x * vx + y * vy;
    const a = 1 / (2 / r - v2 / MU);
    const exv = ((v2 - MU / r) * x - rv * vx) / MU, eyv = ((v2 - MU / r) * y - rv * vy) / MU;
    const e = Math.hypot(exv, eyv), w = Math.atan2(eyv, exv);
    const n = Math.sqrt(MU / (a * a * a));
    const cosE0 = clamp((1 - r / a) / Math.max(e, 1e-12), -1, 1);
    let E0 = Math.acos(cosE0);
    if (rv < 0) E0 = 2 * Math.PI - E0;
    const M = E0 - e * Math.sin(E0) + n * dt;
    let E = M;
    for (let i = 0; i < 30; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const b = a * Math.sqrt(1 - e * e);
    const px = a * (Math.cos(E) - e), py = b * Math.sin(E);
    const rr = a * (1 - e * Math.cos(E)), k = Math.sqrt(MU * a) / rr;
    const qx = -k * Math.sin(E), qy = k * Math.sqrt(1 - e * e) * Math.cos(E);
    const c = Math.cos(w), sn = Math.sin(w);
    return { x: c * px - sn * py, y: sn * px + c * py, vx: c * qx - sn * qy, vy: sn * qx + c * qy };
  }
  // Rotating-frame effective potential (per kg) used for climbers and tethers.
  const phiEff = r => -MU / r - 0.5 * OMEGA * OMEGA * r * r;
  // Hoyt/Moravec: minimum mass of a constant-stress tapered rotating tether (or spin arm) per unit tip mass.
  function erf(x) { // Abramowitz–Stegun 7.1.26
    const s = Math.sign(x); x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  function tetherMassRatio(vTip, vc) {
    const x = vTip / vc;
    return Math.sqrt(Math.PI) * x * Math.exp(x * x) * erf(x);
  }
  const charVelocity = (sigma, rho, sf) => Math.sqrt(2 * sigma / (rho * sf));

  // ───────────────────────── propellants, energy, emissions ─────────────────────────
  // eChem: combustion enthalpy released per kg of propellant mix (LHV of fuel / mix ratio).
  // mjFossil + kwh: energy spent making 1 kg (refining, air separation, electrolysis, liquefaction).
  // co2: direct combustion CO2 per kg of mix. cost: $/kg delivered at the site.
  const PROPS = {
    kerolox: { label: 'RP-1 / LOX', eChem: 12.1e6, mjFossil: 1.4, kwh: 0.22, co2: 0.885, cost: 0.67 },
    methalox: { label: 'CH₄ / LOX', eChem: 10.9e6, mjFossil: 0.65, kwh: 0.24, co2: 0.598, cost: 0.23 },
    solid: { label: 'APCP solid', eChem: 7.5e6, mjFossil: 20, kwh: 0, co2: 0.30, cost: 10 },
    storable: { label: 'NTO / MMH', eChem: 6.5e6, mjFossil: 40, kwh: 0, co2: 0.45, cost: 100 },
    h2heat: { label: 'LH₂ working fluid', eChem: 0, mjFossil: 0, kwh: 66, co2: 0, cost: 8 },
    jetA: { label: 'Jet-A (carrier aircraft)', eChem: 43.2e6, mjFossil: 4, kwh: 0, co2: 3.16, cost: 0.8 },
    natgas: { label: 'Natural gas (gun charge)', eChem: 50e6, mjFossil: 2, kwh: 0, co2: 2.75, cost: 0.3 },
    hydrogen: { label: 'H₂ gun working gas', eChem: 0, mjFossil: 0, kwh: 55, co2: 0, cost: 5 },
    helium: { label: 'Helium lift gas', eChem: 0, mjFossil: 30, kwh: 0, co2: 0, cost: 50 },
  };
  const FOSSIL_CO2 = 0.07; // kg CO2 per MJ of fossil process energy

  // ───────────────────────── structural & cost laws ─────────────────────────
  // Stage structural coefficient ε = dry/(dry+prop) grows as stages shrink (fit: Falcon 9 ↔ Electron).
  const STRUCT = {
    booster: p => 0.0482 + 0.9406 * Math.cbrt(1 / Math.max(p, 1)),
    upper: p => 0.0135 + 1.20 * Math.cbrt(1 / Math.max(p, 1)),
    kick: p => 0.06 + 0.50 * Math.cbrt(1 / Math.max(p, 1)),
  };
  const stageCost = (dry, mult) => 68000 * Math.pow(Math.max(dry, 1), 0.6) * (mult || 1); // TRANSCOST-style, $ (F9 S1 ≈ $30M)
  const fairingMass = pl => Math.max(8, 4.5 * Math.pow(pl, 0.6));
  const fairingCost = m => 64500 * Math.pow(m, 0.6);
  const opsCost = glow => 1e6 + 1e5 * Math.sqrt(glow / 1000);
  const rocketDiameter = glow => Math.max(0.3, 0.45 * Math.cbrt(glow / 1000));
  const hardeningFactor = g => 1 + 0.15 * Math.log10(Math.max(1, g / 10));
  const shellFraction = g => 0.08 + 0.03 * Math.log10(Math.max(10, g) / 10);

  // ───────────────────────── trajectory integrator ─────────────────────────
  // State [x, y, vx, vy, m] in an Earth-centred inertial plane. Launch site at (r0, 0); +y is downrange (east).
  // The atmosphere co-rotates at ω_eff = ω·cos(latitude).
  const K = { omega: 0, cdTab: CD_ROCKET, area: 1, mdot: 0, ispSL: 0, ispVac: 0, dir: 0, theta: 0 };
  function deriv(s, out) {
    const x = s[0], y = s[1], vx = s[2], vy = s[3], m = s[4];
    const r2 = x * x + y * y, r = Math.sqrt(r2);
    const gk = -MU / (r2 * r);
    let ax = gk * x, ay = gk * y;
    const vrx = vx + K.omega * y, vry = vy - K.omega * x, vrel = Math.sqrt(vrx * vrx + vry * vry);
    const A = atm(r - RE);
    if (vrel > 1e-3 && A.rho > 1e-15) {
      const cd = lerpTab(K.cdTab, vrel / A.a);
      const Dm = 0.5 * A.rho * vrel * cd * K.area / m;
      ax -= Dm * vrx; ay -= Dm * vry;
    }
    let dm = 0;
    if (K.mdot > 0) {
      const isp = K.ispVac - (K.ispVac - K.ispSL) * Math.min(1, A.p / P0);
      const Tm = K.mdot * G0 * isp / m;
      let ux, uy;
      if (K.dir === 1 && vrel > 1) { ux = vrx / vrel; uy = vry / vrel; }
      else {
        const ex = x / r, ey = y / r, c = Math.cos(K.theta), sn = Math.sin(K.theta);
        ux = -c * ey + sn * ex; uy = c * ex + sn * ey;
      }
      ax += Tm * ux; ay += Tm * uy; dm = -K.mdot;
    }
    out[0] = vx; out[1] = vy; out[2] = ax; out[3] = ay; out[4] = dm;
  }
  const _k1 = new Float64Array(5), _k2 = new Float64Array(5), _k3 = new Float64Array(5), _k4 = new Float64Array(5), _tmp = new Float64Array(5);
  function rk4(s, dt) {
    deriv(s, _k1);
    for (let i = 0; i < 5; i++) _tmp[i] = s[i] + 0.5 * dt * _k1[i];
    deriv(_tmp, _k2);
    for (let i = 0; i < 5; i++) _tmp[i] = s[i] + 0.5 * dt * _k2[i];
    deriv(_tmp, _k3);
    for (let i = 0; i < 5; i++) _tmp[i] = s[i] + dt * _k3[i];
    deriv(_tmp, _k4);
    for (let i = 0; i < 5; i++) s[i] += dt / 6 * (_k1[i] + 2 * _k2[i] + 2 * _k3[i] + _k4[i]);
  }

  // Instantaneous energy flows for the ledger, using the controls currently in K:
  // [0] jet power ½ṁc², [1] mechanical-energy flux into the exhaust ṁ(½|v⃗ − c·û|² − μ/r − ε_g), [2] drag dissipation −D⃗·v⃗.
  const _er0 = new Float64Array(3), _er1 = new Float64Array(3);
  function energyRates(s, epsG, out) {
    const x = s[0], y = s[1], vx = s[2], vy = s[3];
    const r = Math.sqrt(x * x + y * y);
    const vrx = vx + K.omega * y, vry = vy - K.omega * x, vrel = Math.sqrt(vrx * vrx + vry * vry);
    const A = atm(r - RE);
    let drag = 0, jet = 0, exh = 0;
    if (vrel > 1e-3 && A.rho > 1e-15) {
      const D = 0.5 * A.rho * vrel * vrel * lerpTab(K.cdTab, vrel / A.a) * K.area;
      drag = D * (vrx * vx + vry * vy) / vrel;
    }
    if (K.mdot > 0) {
      const c = G0 * (K.ispVac - (K.ispVac - K.ispSL) * Math.min(1, A.p / P0));
      let ux, uy;
      if (K.dir === 1 && vrel > 1) { ux = vrx / vrel; uy = vry / vrel; }
      else { const ex = x / r, ey = y / r, cs = Math.cos(K.theta), sn = Math.sin(K.theta); ux = -cs * ey + sn * ex; uy = cs * ex + sn * ey; }
      jet = 0.5 * K.mdot * c * c;
      const wx = vx - c * ux, wy = vy - c * uy;
      exh = K.mdot * (0.5 * (wx * wx + wy * wy) - MU / r - epsG);
    }
    out[0] = jet; out[1] = exh; out[2] = drag;
  }

  /* fly(veh, init, tgt, gp, opt)
   *  veh:  { stages:[{prop, dry, reserve, ispSL, ispVac, mdot}], payload, fairing, shell, area, shellArea, cdTab, rn, aMax, single }
   *  init: { x, y, vx, vy, omega, mode:'pad'|'air'|'coast' }
   *  tgt:  { kind:'orbit'|'catch', r, vh, eps }
   *  gp:   pitch-kick (deg) for pad starts, initial climb angle (deg) for air starts
   * Returns the flight with an exact Δv ledger: Δv_ideal = Δ|v| + gravity + drag + steering losses. */
  function fly(veh, init, tgt, gp, opt) {
    opt = opt || {};
    const rec = opt.record ? [] : null, events = opt.record ? [] : null;
    const st = veh.stages.map(s => ({ left: s.prop, reserveMass: s.prop * (s.reserve || 0), prop: s.prop, dry: s.dry, ispSL: s.ispSL, ispVac: s.ispVac, mdot: s.mdot, key: s.key }));
    const s = new Float64Array(5);
    s[0] = init.x; s[1] = init.y; s[2] = init.vx; s[3] = init.vy;
    let m = veh.payload + veh.fairing + veh.shell;
    for (const q of st) m += q.prop + q.dry;
    s[4] = m;
    const m0 = m;
    K.omega = init.omega;
    let shellOn = veh.shell > 0, fairOn = veh.fairing > 0;
    let ignited = init.mode !== 'coast';
    let si = 0, t = 0, coastUntil = 0, mode = init.mode === 'air' ? 'hold' : init.mode === 'pad' ? 'vert' : 'guided';
    if (init.mode === 'pad' && veh.stages.length === 0) mode = 'guided';
    let theta = Math.PI / 2, frozen = false, tk = 0;
    let dvIdeal = 0, lg = 0, ld = 0, ls = 0, peakG = 0, peakQ = 0, peakHeat = 0, heatLoad = 0, dragWork = 0, maxAlt = 0, maxMach = 0;
    let cut = false, crashed = false, exhausted = false, tIgn = ignited ? 0 : -1, tCut = 0;
    const v0 = Math.hypot(s[2], s[3]);
    // Energy ledger, mechanical energies measured from the ground state ε_g (at rest on the rotating surface).
    // jet: ½·ṁ·c² (Sutton's jet power); exhaust: mechanical energy left in the plume; drag: −∫D⃗·v⃗ dt (inertial);
    // hardware: mechanical energy carried off by everything jettisoned. Closure: E0 + jet = Ef + drag + exhaust + hardware.
    const epsG = init.epsG != null ? init.epsG : 0.5 * (s[2] * s[2] + s[3] * s[3]) - MU / Math.hypot(s[0], s[1]);
    const E0 = s[4] * (0.5 * (s[2] * s[2] + s[3] * s[3]) - MU / Math.hypot(s[0], s[1]) - epsG);
    let eJet = 0, eExh = 0, eDrag = 0, eHw = 0;
    const tMax = opt.tMax || 6000;
    let nextRec = 0;
    const kickRad = (gp || 0) * D2R;
    const push = (ph) => {
      if (!rec) return;
      const r = Math.hypot(s[0], s[1]);
      const ang = Math.atan2(s[1], s[0]) - K.omega * t;
      const vrx = s[2] + K.omega * s[1], vry = s[3] - K.omega * s[0];
      rec.push({ t, alt: (r - RE) / 1000, dr: ang * RE / 1000, v: Math.hypot(s[2], s[3]), vrel: Math.hypot(vrx, vry), m: s[4], ph, x: s[0] / 1000, y: s[1] / 1000, g: lastG, q: lastQ });
    };
    const ev = (label) => { if (events) events.push({ t, label }); };
    let lastG = 0, lastQ = 0;
    if (init.mode === 'coast') ev('Leaves the launcher');
    else if (init.mode === 'air') ev('Drop from carrier · ignition');
    else ev('Ignition · liftoff');

    while (t < tMax) {
      const x = s[0], y = s[1], vx = s[2], vy = s[3];
      m = s[4];
      const r = Math.hypot(x, y), alt = r - RE;
      if (alt < -1 && t > 0.5) { crashed = true; ev('Impact'); break; }
      if (alt > maxAlt) maxAlt = alt;
      const ex = x / r, ey = y / r, tx = -ey, ty = ex;
      const v = Math.hypot(vx, vy), vr = vx * ex + vy * ey, vh = vx * tx + vy * ty;
      const vrx = vx + K.omega * y, vry = vy - K.omega * x, vrel = Math.hypot(vrx, vry);
      const A = atm(alt), q = 0.5 * A.rho * vrel * vrel, mach = vrel / A.a;
      if (mach > maxMach) maxMach = mach;
      const area = shellOn ? veh.shellArea : veh.area;
      K.cdTab = shellOn ? CD_SLENDER : veh.cdTab; K.area = area;
      const Dmag = q * lerpTab(K.cdTab, mach) * area;
      const eps = 0.5 * v * v - MU / r;

      if (fairOn && alt > 110e3) { eHw += veh.fairing * (eps - epsG); m -= veh.fairing; s[4] = m; fairOn = false; ev('Fairing jettison'); }

      // coasting projectile: light the onboard stage near apoapsis (or as soon as it is out of the air if the arc is too low)
      if (!ignited) {
        let go = false, rIns = 0;
        if (alt > 30e3 && q < 1000) {
          const el = elems(x, y, vx, vy);
          if (el.ra >= RE + 120e3 && vr > 0) {
            const sg = st[si];
            const aT = sg.mdot * G0 * sg.ispVac / (m - (shellOn ? veh.shell : 0));
            const eT = epsOf(el.ra, tgt.rFinal || tgt.r);
            const dvc = Math.max(0, speedAt(eT, el.ra) - el.h / el.ra);
            if (timeToApo(el) <= 0.5 * dvc / aT + 1) { go = true; rIns = el.ra; }
          } else { go = true; rIns = Math.min(tgt.rFinal || tgt.r, RE + 200e3); }
        }
        if (vr < 0 && t > 1 && !go) { go = true; rIns = Math.max(r, Math.min(tgt.rFinal || tgt.r, RE + 200e3)); }
        if (go) {
          ignited = true; tIgn = t;
          if (shellOn) { eHw += veh.shell * (eps - epsG); m -= veh.shell; s[4] = m; shellOn = false; ev('Aeroshell jettison'); }
          mode = 'guided';
          // insert at this altitude onto the transfer ellipse whose other apsis is the parking orbit
          if (tgt.kind === 'orbit') {
            const rf = tgt.rFinal || tgt.r, eI = epsOf(rIns, rf);
            tgt = { kind: 'orbit', r: rIns, vh: speedAt(eI, rIns), eps: eI, rFinal: rf };
          }
          ev('Onboard stage ignition');
        }
      }

      // thrust & guidance
      let thrusting = false, mdot = 0, Tmag = 0, ux = 0, uy = 0, isp = 0;
      if (ignited && !cut && si < st.length && t >= coastUntil) {
        const sg = st[si];
        if (sg.left - sg.reserveMass <= 1e-6) {
          eHw += (sg.dry + sg.left) * (eps - epsG);
          m -= sg.dry + sg.left; s[4] = m; si++;
          if (si >= st.length) { exhausted = true; ev('Propellant depleted'); break; }
          coastUntil = t + 2; mode = 'guided'; frozen = false;
          ev(`Stage ${si} separation`);
          continue;
        }
        thrusting = true;
        isp = sg.ispVac - (sg.ispVac - sg.ispSL) * Math.min(1, A.p / P0);
        const Tfull = sg.mdot * G0 * isp;
        let thr = 1;
        if (Tfull / m > veh.aMax) thr = Math.max(0.4, veh.aMax / (Tfull / m));
        mdot = sg.mdot * thr; Tmag = mdot * G0 * isp;
        const aT = Tmag / m;
        // pitch program
        if (mode === 'vert') {
          theta = Math.PI / 2;
          if (vrel > 55) { mode = 'kick'; tk = t; }
        }
        if (mode === 'kick') {
          theta = Math.PI / 2 - kickRad * Math.min(1, (t - tk) / 6);
          if (t - tk >= 6) {
            const gRel = Math.atan2(vrx * ex + vry * ey, vrx * tx + vry * ty);
            if (gRel <= theta) mode = 'pro';
          }
        }
        if (mode === 'hold') { // air launch: pull up at a fixed attitude, then hand over to guidance
          theta = kickRad;
          if (t > 25) mode = 'guided';
        }
        if (mode === 'pro' && (si > 0 || veh.single) && alt > 40e3 && q < 5000) { mode = 'guided'; frozen = false; }
        if (mode === 'guided') {
          const dvh = Math.max(5, tgt.vh - vh);
          // time-to-go across every remaining stage at full thrust
          let tgo0 = 0, need = dvh, mm = m;
          for (let k = si; k < st.length && need > 0; k++) {
            const q2 = st[k], ve2 = G0 * q2.ispVac, use = Math.max(0, q2.left - q2.reserveMass);
            const capDv = ve2 * Math.log(mm / Math.max(1e-9, mm - use));
            if (need <= capDv || k === st.length - 1) { tgo0 += mm / q2.mdot * (1 - Math.exp(-need / ve2)); need = 0; }
            else { tgo0 += use / q2.mdot + 2; need -= capDv; mm -= q2.left + q2.dry; }
          }
          if (!frozen) {
            const tgo = Math.max(tgo0, 6);
            const acmd = 6 * (tgt.r - r) / (tgo * tgo) - 4 * vr / tgo;
            const sn = clamp((acmd + MU / (r * r) - vh * vh / r) / aT, -0.7, 0.98);
            theta = Math.asin(sn);
            if (tgo0 < 6) frozen = true;
          }
        }
        if (mode === 'pro' && vrel > 1) { ux = vrx / vrel; uy = vry / vrel; }
        else { const c = Math.cos(theta), sn = Math.sin(theta); ux = c * tx + sn * ex; uy = c * ty + sn * ey; }
      }

      // step size
      let dt;
      if (thrusting) dt = alt < 80e3 ? 0.25 : 0.5;
      else dt = alt < 100e3 ? (q > 500 ? 0.1 : 0.5) : (ignited ? 2 : 2);
      if (Dmag > 0 && vrel > 10) dt = Math.min(dt, Math.max(0.004, 0.01 * vrel * m / Dmag));
      if (!ignited && alt > 100e3) { // coast: don't overshoot the ignition window by much
        dt = Math.min(dt, 2);
      }
      if (thrusting) {
        const sg = st[si];
        const usable = sg.left - sg.reserveMass;
        if (mdot * dt > usable) dt = Math.max(1e-3, usable / mdot);
        // energy cutoff look-ahead
        const pw = (Tmag / m) * (ux * vx + uy * vy);
        if (pw > 0 && eps + pw * dt > tgt.eps) dt = Math.max(0.01, (tgt.eps - eps) / pw);
      }
      if (t < coastUntil) dt = Math.min(dt, coastUntil - t + 1e-6);

      // losses (Euler at step start; exact ledger closes to a few m/s)
      const g = MU / (r * r);
      if (v > 1) lg += g * (vr / v) * dt;
      if (v > 1 && vrel > 1e-3) ld += (Dmag / m) * ((vrx * vx + vry * vy) / (vrel * v)) * dt;
      if (thrusting) {
        dvIdeal += Tmag / m * dt;
        if (v > 1) ls += Tmag / m * (1 - (ux * vx + uy * vy) / v) * dt;
      }
      // felt load (non-gravitational)
      const fx = (thrusting ? Tmag * ux : 0) - (vrel > 1e-3 ? Dmag * vrx / vrel : 0);
      const fy = (thrusting ? Tmag * uy : 0) - (vrel > 1e-3 ? Dmag * vry / vrel : 0);
      lastG = Math.hypot(fx, fy) / m / G0; lastQ = q;
      if (lastG > peakG) peakG = lastG;
      if (q > peakQ) peakQ = q;
      if (veh.rn && shellOn) {
        const hq = SUTTON_GRAVES * Math.sqrt(A.rho / veh.rn) * vrel * vrel * vrel;
        if (hq > peakHeat) peakHeat = hq;
        heatLoad += hq * dt;
      }
      dragWork += Dmag * vrel * dt;

      if (rec && t >= nextRec) { push(thrusting ? (mode === 'guided' ? 2 : 1) : (ignited ? 3 : 0)); nextRec = t + (thrusting ? 2 : (alt < 100e3 ? 1 : 10)); }

      // integrate
      K.mdot = thrusting ? mdot : 0;
      if (thrusting) {
        K.ispSL = st[si].ispSL; K.ispVac = st[si].ispVac;
        if (mode === 'pro') K.dir = 1; else { K.dir = 0; K.theta = theta; }
      }
      // energy ledger: trapezoid of the rates at both ends of the step, same controls
      energyRates(s, epsG, _er0);
      rk4(s, dt);
      energyRates(s, epsG, _er1);
      eJet += 0.5 * (_er0[0] + _er1[0]) * dt;
      eExh += 0.5 * (_er0[1] + _er1[1]) * dt;
      eDrag += 0.5 * (_er0[2] + _er1[2]) * dt;
      if (thrusting) st[si].left -= mdot * dt;
      t += dt;

      // post-step: cutoff
      if (thrusting) {
        const e2 = 0.5 * (s[2] * s[2] + s[3] * s[3]) - MU / Math.hypot(s[0], s[1]);
        if (e2 >= tgt.eps - 1) { cut = true; tCut = t; ev(tgt.kind === 'catch' ? 'Engine cutoff · coasting to the tether tip' : 'Engine cutoff · orbit energy reached'); break; }
      }
    }
    if (!cut && !crashed && !exhausted) exhausted = true;

    // results
    const el = elems(s[0], s[1], s[2], s[3]);
    let trim = 0, shortfall = 0;
    if (cut) {
      if (tgt.kind === 'orbit') trim = dvToCircular(el.rp, el.ra, el.eps, tgt.rFinal || tgt.r);
      else {
        const ra = isFinite(el.ra) ? el.ra : tgt.r;
        trim = Math.abs(el.h / tgt.r - tgt.vh) + Math.abs(ra - tgt.r) * (MU / (tgt.r * tgt.r)) / Math.max(500, tgt.vh);
      }
    } else {
      const dE = Math.max(0, tgt.eps - el.eps);
      shortfall = (-el.v + Math.sqrt(el.v * el.v + 2 * dE)) * 1.1 + (crashed ? 800 : 150);
    }
    // Δv still available in the stack
    let leftover = 0;
    if (!crashed) {
      let mm = s[4];
      for (let k = si; k < st.length; k++) {
        const use = Math.max(0, st[k].left - st[k].reserveMass);
        if (use > 0) leftover += G0 * st[k].ispVac * Math.log(mm / (mm - use));
        mm -= st[k].left + st[k].dry;
      }
    }
    if (rec) {
      push(cut ? 4 : 5);
      // a vehicle heading for a tether tip coasts up to apoapsis, where the catch happens: record that arc
      if (cut && tgt.kind === 'catch' && el.eps < 0) {
        const tApo = timeToApoNear(el), x0 = s[0], y0 = s[1], vx0 = s[2], vy0 = s[3], t0 = t;
        if (tApo > 1)
        for (let i = 1; i <= 24; i++) {
          const st2 = keplerPropagate(x0, y0, vx0, vy0, tApo * i / 24), tt = t0 + tApo * i / 24;
          const rr = Math.hypot(st2.x, st2.y), vrx = st2.vx + K.omega * st2.y, vry = st2.vy - K.omega * st2.x;
          rec.push({ t: tt, alt: (rr - RE) / 1000, dr: (Math.atan2(st2.y, st2.x) - K.omega * tt) * RE / 1000, v: Math.hypot(st2.vx, st2.vy), vrel: Math.hypot(vrx, vry), m: s[4], ph: 3, x: st2.x / 1000, y: st2.y / 1000, g: 0, q: 0 });
        }
      }
    }
    if (cut && events) {
      if (tgt.kind === 'orbit' && trim > 20) events.push({ t: t + timeToApo(el), label: `Circularisation burn at apoapsis (${Math.round(trim)} m/s)` });
    }
    const need = dvIdeal + trim + shortfall;
    const avail = dvIdeal + leftover;
    return {
      ok: cut, cut, crashed, exhausted, t, tCut, tIgn, el, si: Math.min(si, st.length - 1), state: { x: s[0], y: s[1], vx: s[2], vy: s[3] },
      energy: { jet: eJet, exhaust: eExh, drag: eDrag, hardware: eHw, E0, Ef: s[4] * (el.eps - epsG), epsG }, dvIdeal, trim, shortfall, leftover, need, avail,
      losses: { gravity: lg, drag: ld, steering: ls }, v0, vf: el.v, m0, mf: s[4],
      peakG, peakQ, peakHeat, heatLoad, dragWork, maxAlt, maxMach, rec, events, stagesLeft: st.map(q => q.left),
    };
  }

  // ───────────────────────── stage sizing ─────────────────────────
  // Tsiolkovsky with a size-dependent structural coefficient; reserve r of the loaded propellant rides to burnout.
  // Solves p·den(p) = (MR−1)·PL, where den = 1 + k − MR·(k + r) improves as the stage grows (ε falls with size).
  function sizeStage(PL, dv, isp, sp) {
    const MR = Math.exp(dv / (G0 * isp));
    const r = sp.reserve || 0;
    const epsAt = p => clamp(STRUCT[sp.law](p) * (sp.mul || 1) + (sp.add || 0), 0.01, 0.9);
    const h = p => { const e = epsAt(p), k = e / (1 - e); return p * (1 + k - MR * (k + r)) - (MR - 1) * PL; };
    if (dv <= 0) return { prop: 0, dry: 0, eps: 0 };
    let lo = Math.max(1e-3, 0.05 * (MR - 1) * PL), hi = lo;
    while (h(hi) < 0) { lo = hi; hi *= 2; if (hi > 1e9 * Math.max(1, PL)) return null; }
    if (h(lo) >= 0) hi = lo;
    else for (let i = 0; i < 60; i++) { const mid = Math.sqrt(lo * hi); if (h(mid) < 0) lo = mid; else hi = mid; if (hi / lo < 1 + 1e-9) break; }
    const p = hi, e = epsAt(p), k = e / (1 - e);
    if (1 + k - MR * (k + r) <= 0.02) return null;
    return { prop: p, dry: k * p, eps: e };
  }
  function ispEff(sp, pStart) { return sp.ispVac - 0.45 * (sp.ispVac - sp.ispSL) * Math.min(1, pStart / P0); }

  function buildVehicle(spec, PL, dv) {
    const top = PL + spec.fairing;
    const pStart = spec.pStart;
    const n = spec.stages.length;
    let best = null;
    const make = (sizes) => {
      const stages = [];
      let mAbove = top;
      for (let k = n - 1; k >= 0; k--) mAbove += sizes[k].prop + sizes[k].dry;
      const glow = mAbove;
      let mIgn = glow;
      for (let k = 0; k < n; k++) {
        const sp = spec.stages[k], sz = sizes[k];
        const ispStart = k === 0 ? sp.ispVac - (sp.ispVac - sp.ispSL) * Math.min(1, pStart / P0) : sp.ispVac;
        const T = sp.tw * (mIgn + (k === 0 ? spec.shell : 0) * 0) * G0;
        stages.push({ prop: sz.prop, dry: sz.dry, reserve: sp.reserve || 0, ispSL: sp.ispSL, ispVac: sp.ispVac, mdot: T / (G0 * ispStart), key: sp.prop, eps: sz.eps });
        mIgn -= sz.prop + sz.dry;
      }
      // projectiles: body diameter follows the launched mass, so the ballistic coefficient stays consistent while sizing
      const d = spec.projD ? spec.projD(glow + (spec.shell || 0)) : rocketDiameter(glow);
      return { stages, payload: PL, fairing: spec.fairing, shell: spec.shell || 0, glow, area: Math.PI * d * d / 4, d,
        shellArea: spec.projD ? Math.PI * d * d / 4 : 0, rn: spec.projD ? Math.max(0.01, 0.06 * d) : 0,
        cdTab: spec.cdTab || CD_ROCKET, aMax: spec.aMax, single: n === 1 };
    };
    if (n === 1) {
      const s1 = sizeStage(top, dv, ispEff(spec.stages[0], pStart), spec.stages[0]);
      return s1 ? make([s1]) : null;
    }
    for (let f = 0.2; f <= 0.7001; f += 0.025) {
      const s2 = sizeStage(top, dv * (1 - f), spec.stages[1].ispVac, spec.stages[1]);
      if (!s2) continue;
      const m2 = top + s2.prop + s2.dry;
      const s1 = sizeStage(m2, dv * f, ispEff(spec.stages[0], pStart), spec.stages[0]);
      if (!s1) continue;
      const glow = m2 + s1.prop + s1.dry;
      if (!best || glow < best.glow) best = { glow, sizes: [s1, s2] };
    }
    return best ? make(best.sizes) : null;
  }

  // Finds the smallest stage stack (parameterised by its design Δv) whose flown trajectory closes.
  // Secant steps while the answer is far; once it is bracketed (a short stack and a long-enough stack), bisection.
  // Bisection matters for projectiles, where size changes the ballistic coefficient and the arc itself.
  function sizeLoop(spec, PL, init, tgt, gp, dv0) {
    let dv = dv0, lo = 0, hi = Infinity, best = null, last = null, lastReason = '';
    const dbg = typeof process !== 'undefined' && process.env && process.env.LBDEBUG;
    for (let it = 0; it < 18; it++) {
      const veh = buildVehicle(spec, PL, dv);
      if (!veh) {
        if (best) { hi = dv; dv = 0.5 * (lo + hi); continue; }
        return { ok: false, reason: `Needs ${(dv / 1000).toFixed(1)} km/s from onboard stages, beyond what this stage technology can close`, dvReq: dv };
      }
      const sim = fly(veh, init, tgt, gp, {});
      const gap = sim.need - sim.avail;
      const good = sim.ok && gap <= 0;
      last = { veh, sim };
      if (dbg) console.log(`  size it${it} dv=${dv.toFixed(0)} glow=${veh.glow.toFixed(0)} ok=${sim.ok} crash=${sim.crashed} used=${sim.dvIdeal.toFixed(0)} trim=${sim.trim.toFixed(0)} short=${sim.shortfall.toFixed(0)} left=${sim.leftover.toFixed(0)} gap=${gap.toFixed(0)} [${lo.toFixed(0)},${hi.toFixed(0)}]`);
      if (good) {
        if (!best || veh.glow < best.veh.glow) best = { veh, sim, dv };
        hi = Math.min(hi, dv);
        if (gap > -6) break;
      } else {
        lo = Math.max(lo, dv);
        lastReason = sim.crashed ? 'Vehicle falls back before reaching orbit' : 'Runs out of propellant short of the target';
      }
      if (hi < Infinity && hi - lo < Math.max(8, 0.002 * hi)) break;
      let next = good ? dv + 0.9 * gap : dv + Math.min(Math.max(gap + 4, 0.08 * dv), 0.8 * dv);
      if (hi < Infinity && (next >= hi || next <= lo)) next = 0.5 * (lo + hi);
      if (lo > 0 && hi < Infinity && it > 4) next = 0.5 * (lo + hi);
      dv = Math.max(100, next);
      if (dv > 25000) break;
    }
    if (!best) return { ok: false, veh: last && last.veh, sim: last && last.sim, dvReq: dv, reason: lastReason || 'Trajectory cannot be closed with this vehicle' };
    return { ok: true, veh: best.veh, sim: best.sim, dvReq: best.dv, reason: '' };
  }

  function designRocket(spec, PL, init, tgt, o) {
    let gp = o.gp;
    let des = sizeLoop(spec, PL, init, tgt, gp, o.dvGuess);
    if (o.gpList && o.gpList.length) {
      let bestGp = gp, bestNeed = des.ok ? des.sim.need : Infinity, base = des.veh;
      if (!base) {
        // find any guidance setting that closes
        for (const g of o.gpList) { const d = sizeLoop(spec, PL, init, tgt, g, o.dvGuess); if (d.ok) { des = d; bestGp = g; base = d.veh; bestNeed = d.sim.need; break; } }
      }
      if (base) {
        for (const g of o.gpList) {
          if (g === bestGp) continue;
          const sm = fly(base, init, tgt, g, {});
          if (sm.crashed) continue;
          const need = sm.need;
          if (need < bestNeed - 2) { bestNeed = need; bestGp = g; }
        }
        if (bestGp !== gp || !des.ok) { gp = bestGp; const d = sizeLoop(spec, PL, init, tgt, gp, des.dvReq); if (d.ok || !des.ok) des = d; else gp = o.gp; }
      }
    }
    if (!des.ok) return des;
    const sim = fly(des.veh, init, tgt, gp, { record: true });
    return { ok: sim.ok, veh: des.veh, sim, gp, dvReq: des.dvReq, reason: sim.ok ? '' : des.reason };
  }

  // ───────────────────────── destinations ─────────────────────────
  function hohmannGEOFromCircular(r, lat) { return dvToGEO(r, r, -MU / (2 * r), lat); }
  function destination(mission) {
    const lat = mission.lat * D2R;
    const d = { key: mission.dest, lat, assist: !!mission.assist };
    const park = RE + (mission.dest === 'LEO' ? mission.alt * 1000 : 300e3);
    d.rPark = park;
    d.epsPark = -MU / (2 * park);
    let C3 = null;
    switch (mission.dest) {
      case 'LEO':
        d.label = `Low Earth orbit, ${mission.alt} km circular`; d.short = `LEO ${mission.alt} km`;
        d.epsFinal = d.epsPark; d.dvDep = 0; d.trip = 0; break;
      case 'GEO':
        d.label = 'Geostationary orbit, 35,786 km'; d.short = 'GEO';
        d.epsFinal = -MU / (2 * R_GEO); d.dvDep = hohmannGEOFromCircular(park, lat); d.trip = 5.3 * HOUR; break;
      case 'TLI':
        C3 = -2 * MU / (park + R_MOON);
        d.label = 'Trans-lunar injection'; d.short = 'Moon (TLI)'; d.trip = 3 * DAY; break;
      case 'MARS':
        C3 = 10e6; d.label = 'Trans-Mars injection, C3 = 10 km²/s²'; d.short = 'Mars (TMI)'; d.trip = 0.7 * YEAR; break;
      case 'JUP':
        C3 = d.assist ? 17e6 : 80e6;
        d.label = d.assist ? 'Jupiter via Venus–Earth–Earth gravity assists, C3 = 17 km²/s²' : 'Jupiter direct, C3 = 80 km²/s²';
        d.short = d.assist ? 'Jupiter (VEEGA)' : 'Jupiter direct'; d.trip = (d.assist ? 6.0 : 2.7) * YEAR; break;
    }
    if (C3 !== null) {
      d.C3 = C3; d.epsFinal = C3 / 2;
      d.dvDep = Math.sqrt(C3 + 2 * MU / park) - vCirc(park);
    }
    d.epsGround = 0.5 * Math.pow(OMEGA * RE * Math.cos(lat), 2) - MU / RE;
    d.usefulPerKg = d.epsFinal - d.epsGround;
    // coasting projectiles aim their apoapsis straight at the parking orbit
    d.tgt = { kind: 'orbit', r: park, vh: vCirc(park), eps: -MU / (2 * park), rFinal: park };
    // powered ascents inject at ≤ 200 km into a transfer ellipse whose apoapsis is the parking orbit
    const rIns = Math.min(park, RE + 200e3);
    d.tgtIns = { kind: 'orbit', r: rIns, vh: speedAt(epsOf(rIns, park), rIns), eps: epsOf(rIns, park), rFinal: park };
    return d;
  }
  // kick / departure stage (storable, Isp 320 s)
  function sizeKick(PL, dv, isp) {
    if (dv <= 0.5) return { prop: 0, dry: 0, total: 0, dv: 0 };
    const s = sizeStage(PL, dv, isp || 320, { law: 'kick', reserve: 0 });
    if (!s) return null;
    return { prop: s.prop, dry: s.dry, total: s.prop + s.dry, dv };
  }
  // Δv from an arbitrary released orbit to the mission destination (used by the tether and elevator)
  function dvFromOrbitToDest(el, D) {
    if (D.key === 'LEO') return dvToCircular(el.rp, el.ra, el.eps, D.rPark);
    if (D.key === 'GEO') return Math.min(dvToGEO(el.rp, el.ra, el.eps, D.lat), isFinite(el.ra) ? dvToGEO(el.ra, el.rp, el.eps, D.lat) : Infinity);
    // escape-type: burn at periapsis for the needed C3 (Oberth)
    const vp = speedAt(el.eps, el.rp);
    return Math.max(0, Math.sqrt(D.C3 + 2 * MU / el.rp) - vp);
  }

  // ───────────────────────── result scaffolding ─────────────────────────
  function newResult(M, ctx) {
    return {
      id: M.id, name: M.name, family: M.family, trl: M.trl, feasible: true, issues: [],
      E: { onboard: 0, ground: 0, space: 0, made: 0 }, co2: 0,
      cost: { hardware: 0, propellant: 0, energy: 0, ops: 0, infra: 0, consumables: 0 },
      propUsed: {}, masses: [], infra: { capex: 0, units: 1, items: [] }, notes: [], events: [], traj: [],
      dv: null, launchMass: 0, peakG: 0, peakHeat: 0, peakQ: 0, time: 0, extra: {},
    };
  }
  function burn(R, ctx, key, kg, where) {
    if (!(kg > 0)) return;
    const P = PROPS[key];
    R.E[where || 'onboard'] += P.eChem * kg;
    R.E.made += (P.mjFossil * 1e6 + P.kwh * 3.6e6) * kg;
    R.co2 += kg * (P.co2 + P.mjFossil * FOSSIL_CO2 + P.kwh * ctx.econ.gridCO2);
    R.cost.propellant += kg * P.cost;
    R.propUsed[key] = (R.propUsed[key] || 0) + kg;
  }
  function electricity(R, ctx, J, where) {
    if (where === 'space') { R.E.space += J; return; }
    R.E.ground += J;
    R.co2 += J / 3.6e6 * ctx.econ.gridCO2;
    R.cost.energy += J / 3.6e6 * ctx.econ.elecPrice;
  }
  function amortize(R, ctx, capex, cap, omFrac, label) {
    const N = ctx.econ.perYear, Y = ctx.econ.years;
    const units = Math.max(1, Math.ceil(N / cap));
    const total = capex * units;
    R.cost.infra += total / (N * Y) + (omFrac || 0.03) * total / N;
    R.infra.capex += total; R.infra.units = Math.max(R.infra.units, units);
    R.infra.cap = cap;
    R.infra.items.push({ label: label || 'Launch infrastructure', capex: total, units });
  }
  function fail(R, text) { R.feasible = false; R.issues.push({ level: 'fail', text }); return R; }
  function warn(R, text) { R.issues.push({ level: 'warn', text }); }
  function addDeparture(R, ctx) {
    const D = ctx.D;
    if (ctx.dep.total > 0) {
      burn(R, ctx, 'storable', ctx.dep.prop);
      R.cost.hardware += stageCost(ctx.dep.dry, 1.6);
      R.masses.push({ label: 'Departure stage (storable)', kg: ctx.dep.total });
      R.events.push({ t: R.time + 1800, label: `Departure burn ${(D.dvDep / 1000).toFixed(2)} km/s → ${D.short}` });
    }
  }
  function rocketTrajToResult(R, sim, phaseNames) {
    R.traj = sim.rec.map(p => ({ ...p, phase: phaseNames[p.ph] || '' }));
    R.events = R.events.concat(sim.events);
    R.peakG = Math.max(R.peakG, sim.peakG); R.peakQ = Math.max(R.peakQ, sim.peakQ);
    R.peakHeat = Math.max(R.peakHeat, sim.peakHeat);
    R.time = sim.t + (sim.trim > 20 ? timeToApo(sim.el) : 0);
    R.orbitAfter = sim.state;
    R._sim = sim;
  }
  function ledger(sim, extra) {
    return Object.assign({
      onboard: sim.dvIdeal + sim.trim, gravity: sim.losses.gravity, drag: sim.losses.drag, steering: sim.losses.steering,
      trim: sim.trim, start: sim.v0, final: sim.vf,
    }, extra || {});
  }

  // ───────────────────────── energy audit (textbook efficiency chain) ─────────────────────────
  // Every joule put in ends up in exactly one place: never used (reserves), lost converting it to jet or kinetic
  // energy, left in the exhaust plume, dissipated by drag, carried off by spent hardware, or in the payload.
  //   η_overall = E_payload / E_in = η_utilisation · η_conversion · η_propulsive · η_aero · η_payload
  // (internal and propulsive efficiency as defined by Sutton & Biblarz, extended end to end for a launch system).
  const C_STORABLE = 320 * G0;
  // After a simulated flight: impulsive trim at apoapsis, unburned propellant, spent top stage.
  function flightLedger(ctx, sim, veh, kind) {
    const epsG = ctx.D.epsGround, en = sim.energy;
    const L = { jet: en.jet, exhaust: en.exhaust, drag: en.drag, hardware: en.hardware, reserve: 0, E0: en.E0, fly: en };
    const n = veh.stages.length, si = Math.min(sim.si, n - 1), left = sim.stagesLeft;
    const chem = k => PROPS[veh.stages[k].key].eChem;
    for (let k = 0; k < si; k++) L.reserve += left[k] * chem(k);           // dropped with earlier stages (landing reserves)
    for (let k = si + 1; k < n; k++) L.reserve += veh.stages[k].prop * chem(k); // stages never lit
    const top = left[si], mcut = sim.mf, epsCut = sim.el.eps;
    if (kind === 'orbit') {
      const c = G0 * veh.stages[si].ispVac;
      const usable = Math.max(0, top - veh.stages[si].prop * (veh.stages[si].reserve || 0));
      const mT = sim.trim > 0.5 ? Math.min(usable, mcut * (1 - Math.exp(-sim.trim / c))) : 0;
      L.reserve += (top - mT) * chem(si);
      const jetT = 0.5 * mT * c * c, epsP = -MU / (2 * ctx.D.rPark);
      const before = mcut * (epsCut - epsG), after = (mcut - mT) * (epsP - epsG);
      L.jet += jetT; L.exhaust += jetT - (after - before);
      L.hardware += (mcut - mT - veh.payload) * (epsP - epsG);
      L.stack = { mass: veh.payload, eps: epsP };
    } else {
      L.reserve += top * chem(si);
      L.hardware += (mcut - veh.payload) * (epsCut - epsG);
      L.stack = { mass: veh.payload, eps: epsCut };
    }
    return L;
  }
  // An impulsive storable-propellant burn (departure or kick stage) taking the stack to the destination energy.
  function burnLedger(ctx, L, stage, payloadMass) {
    if (!stage || !(stage.prop > 0)) return;
    const epsG = ctx.D.epsGround, epsF = ctx.D.epsFinal;
    const jet = 0.5 * stage.prop * C_STORABLE * C_STORABLE;
    const before = L.stack.mass * (L.stack.eps - epsG), after = (payloadMass + stage.dry) * (epsF - epsG);
    L.jet += jet; L.exhaust += jet - (after - before); L.hardware += stage.dry * (epsF - epsG);
    L.stack = { mass: payloadMass, eps: epsF };
  }
  // Mechanical energy a launcher hands over, measured in the ground frame (speed relative to the ground, height above sea level).
  // Sutton & Biblarz: instantaneous propulsive efficiency of a jet, vehicle speed u, effective exhaust velocity c.
  const propulsiveEfficiency = (u, c) => 2 * (u / c) / (1 + (u / c) * (u / c));
  const groundFrameMech = (m, vRel, h) => m * (0.5 * vRel * vRel + MU / RE - MU / (RE + h));

  function buildCascade(R) {
    const c = R._cas;
    if (!R.feasible || !c) { R.cascade = null; R.etaOverall = null; return; }
    const src = [];
    if (R.E.onboard > 0) src.push({ k: 'chem', label: 'Onboard propellant (chemical energy)', J: R.E.onboard });
    if (R.E.ground > 0) src.push({ k: 'ground', label: c.groundLabel || 'Ground energy', J: R.E.ground });
    if (R.E.space > 0) src.push({ k: 'space', label: 'Solar power in orbit (tether reboost)', J: R.E.space });
    if ((c.env || 0) > 1) src.push({ k: 'env', label: c.envLabel || 'Environment', J: c.env, env: true });
    const Ein = src.reduce((a, s) => a + s.J, 0);
    const mech = c.jet + (c.launcherMech || 0) + Math.max(0, c.env || 0);
    const payload = R.useful, reserve = c.reserve || 0;
    const conversion = Ein - reserve - mech;
    const hardware = mech - c.exhaust - c.drag - payload; // closes the ledger exactly
    const closure = (hardware - c.hardware) / Ein;        // independent check from the integrator
    const R1 = Ein - reserve, R2 = R1 - conversion, R3 = R2 - c.exhaust, R4 = R3 - c.drag;
    R.cascade = {
      Ein, sources: src, mech, closure, convNote: c.convNote || '',
      bins: [
        { k: 'reserve', label: 'Reserves & unburned propellant', J: reserve },
        { k: 'conversion', label: 'Conversion losses', J: conversion },
        { k: 'exhaust', label: 'Left in the exhaust plume', J: c.exhaust },
        { k: 'drag', label: 'Drag & aerodynamic heating', J: c.drag },
        { k: 'hardware', label: 'Spent hardware', J: hardware },
        { k: 'payload', label: 'Payload orbital energy', J: payload },
      ],
      eta: { utilisation: R1 / Ein, conversion: R2 / R1, propulsive: R3 / R2, aero: R4 / R3, payload: payload / R4, overall: payload / Ein },
    };
    R.etaOverall = payload / Ein;
  }

  // ───────────────────────── method families ─────────────────────────
  const KICKS = [0.6, 1, 1.5, 2, 2.6, 3.3, 4.2, 5.5, 7];
  const KICKS_FAST = [1, 2, 3.3, 5];
  const GAMMAS = [35, 45, 55, 65, 75];
  const PH_ROCKET = ['Coast', 'Gravity turn', 'Guided ascent', 'Coast', 'Cutoff', 'End'];

  function stageSpec(prop, law, o) {
    return Object.assign({ prop, law, ispSL: o.ispSL || o.ispVac, ispVac: o.ispVac, tw: o.tw, mul: 1, add: 0, reserve: 0 }, o);
  }

  // Shared ground- or air-started rocket.
  function runRocket(M, ctx, P, cfg) {
    const R = newResult(M, ctx), D = ctx.D;
    const PL = ctx.PLeff;
    const startAlt = cfg.startAlt || 0;
    const pStart = atm(startAlt).p;
    const spec = { stages: cfg.stages, fairing: cfg.noFairing ? 0 : fairingMass(PL), pStart, cdTab: CD_ROCKET, aMax: ctx.aMax, shell: 0 };
    const r0 = RE + startAlt;
    const init = { x: r0, y: 0, vx: 0, vy: ctx.omega * r0 + (cfg.startV || 0), omega: ctx.omega, mode: cfg.mode || 'pad', epsG: ctx.D.epsGround };
    const gpList = cfg.mode === 'air' ? GAMMAS : (ctx.fast ? KICKS_FAST : KICKS);
    const des = designRocket(spec, PL, init, D.tgtIns, { gp: cfg.mode === 'air' ? 55 : 2.6, gpList, dvGuess: cfg.dvGuess || 9300 });
    if (!des.ok) return fail(R, des.reason || 'Could not close the ascent');
    const veh = des.veh, sim = des.sim;
    R.launchMass = veh.glow; R.vehicle = veh; R.gp = des.gp;
    veh.stages.forEach((sg, k) => {
      burn(R, ctx, sg.key, sg.prop);
      R.masses.push({ label: `Stage ${k + 1} propellant`, kg: sg.prop }, { label: `Stage ${k + 1} structure & engines`, kg: sg.dry });
    });
    if (spec.fairing) R.masses.push({ label: 'Payload fairing', kg: spec.fairing });
    R.masses.push({ label: 'Payload', kg: ctx.payload.mass });
    rocketTrajToResult(R, sim, PH_ROCKET);
    R.dv = ledger(sim, { rotation: ctx.omega * RE, assist: cfg.startV || 0 });
    if (sim.peakG > ctx.payload.gTol * 1.02) warn(R, `Peak ${sim.peakG.toFixed(1)} g exceeds the payload limit even at minimum throttle`);
    if (sim.peakG > ctx.payload.gTol * 1.15) fail(R, `Acceleration ${sim.peakG.toFixed(1)} g exceeds the payload's ${ctx.payload.gTol} g limit`);
    R.time = sim.t + (sim.trim > 20 ? timeToApo(sim.el) : 0);
    R.orbitAfter = sim.state;
    addDeparture(R, ctx);
    R.ops = opsCost(veh.glow);
    // energy audit
    const L = flightLedger(ctx, sim, veh, 'orbit');
    burnLedger(ctx, L, ctx.dep, ctx.payload.mass);
    let launcherMech = 0, env = 0, envLabel = '';
    if (cfg.mode === 'air') { launcherMech = groundFrameMech(veh.glow, cfg.startV || 0, startAlt); env = L.E0 - launcherMech; envLabel = "Earth's rotation"; }
    else if (startAlt > 0) { env = L.E0; envLabel = 'Buoyancy of the lift gas'; }
    R._cas = Object.assign(L, { launcherMech, env, envLabel, groundLabel: cfg.groundLabel, convNote: cfg.convNote || 'Combustion energy that never becomes jet kinetic energy (Sutton’s internal efficiency).' });
    return R;
  }

  // Gun-, sling- and track-launched projectiles carrying a hardened onboard stack.
  function runGun(M, ctx, P, cfg) {
    const R = newResult(M, ctx), D = ctx.D, pay = ctx.payload;
    const PL = ctx.PLeff;
    const aTol = pay.gTol * G0;
    // velocity the payload can survive
    const vG = cfg.centripetal ? Math.sqrt(aTol * P.armR) : Math.sqrt(2 * P.L * aTol / P.peak);
    let vMax = Math.min(P.vMax, vG);
    let limitedBy = vMax < P.vMax - 1 ? 'g' : 'tech';
    if (cfg.material) {
      const vc = charVelocity(P.sigma * 1e9, P.rhoArm, P.sf);
      const ratio = tetherMassRatio(P.vMax, vc);
      R.extra.armRatio = ratio; R.extra.armVc = vc;
      if (ratio > 200) return fail(R, `Spin-arm tip speed ${P.vMax} m/s is ${(P.vMax / vc).toFixed(2)}× the material's characteristic velocity; the arm would need ${Math.round(ratio)}× the projectile mass`);
    }
    if (vMax < 700) {
      R.extra.vMax = vMax;
      return fail(R, `Within the payload's ${pay.gTol.toLocaleString()} g limit this launcher could only reach ${Math.round(vMax)} m/s: no useful boost`);
    }
    const r0 = RE + P.exitAlt;
    const om = ctx.omega;
    const rhoProj = 0.5 * pay.density + 600;
    const projD = Mp => Math.cbrt(4 * Mp / (Math.PI * rhoProj * 8 * 0.6));
    const tgt = D.tgt;
    const fast = ctx.fast;

    const stage1 = stageSpec('solid', 'upper', { ispSL: 265, ispVac: 292, tw: 2.2 });
    const stage2 = stageSpec('storable', 'upper', { ispSL: 290, ispVac: 318, tw: 1.6 });
    const evalAt = (elevDeg, v, nStages, record) => {
      const gLaunch = cfg.centripetal ? v * v / P.armR / G0 : v * v / (2 * P.L) * P.peak / G0;
      const hard = hardeningFactor(gLaunch);
      const st = nStages === 1 ? [Object.assign({}, stage2, { mul: hard })] : [Object.assign({}, stage1, { mul: hard }), Object.assign({}, stage2, { mul: hard })];
      const e = elevDeg * D2R;
      const init = { x: r0, y: 0, vx: v * Math.sin(e), vy: om * r0 + v * Math.cos(e), omega: om, mode: 'coast', epsG: ctx.D.epsGround };
      // aeroshell + hardening scale with the stack; ablator scales with the drag work done on the way out of the air
      let shell = 0.15 * PL, abl = 0, des = null, dvG = Math.max(800, (vCirc(tgt.r) - v * Math.cos(e)) * 0.9);
      const specOf = () => ({ stages: st, fairing: 0, pStart: 0, cdTab: CD_SLENDER, aMax: Math.max(aTol, 3 * G0), shell: shell + abl, projD });
      for (let k = 0; k < (fast ? 2 : 3); k++) {
        des = designRocket(specOf(), PL, init, tgt, { gp: 0, gpList: null, dvGuess: dvG });
        if (!des.ok) return { obj: Infinity, des };
        dvG = des.dvReq;
        const glow = des.veh.glow;
        const shellNew = shellFraction(gLaunch) * glow;
        const ablNew = 0.05 * des.sim.dragWork / 40e6;
        const done = Math.abs(shellNew + ablNew - shell - abl) < 0.01 * glow;
        shell = shellNew; abl = ablNew;
        if (done) break;
      }
      if (record) {
        des = designRocket(specOf(), PL, init, tgt, { gp: 0, gpList: null, dvGuess: dvG });
        if (!des.ok) return { obj: Infinity, des };
        des.diam = des.veh.d;
      }
      const Mproj = des.veh.glow + shell + abl;
      // atmospheric deceleration right after the muzzle is also a load the payload must survive
      if (des.sim.peakG > pay.gTol * 1.02) return { obj: Infinity, des, dragG: des.sim.peakG };
      if (typeof process !== 'undefined' && process.env && process.env.LBGUN) console.log(`  gun e=${elevDeg.toFixed(1)} v=${v.toFixed(0)} n=${nStages} M=${Mproj.toFixed(0)} used=${des.sim.dvIdeal.toFixed(0)} tr=${des.sim.trim.toFixed(0)} drag=${des.sim.losses.drag.toFixed(0)} grav=${des.sim.losses.gravity.toFixed(0)} steer=${des.sim.losses.steering.toFixed(0)} apo=${(des.sim.maxAlt / 1e3).toFixed(0)} tIgn=${des.sim.tIgn.toFixed(0)}`);
      return { obj: Mproj, des, shell, abl, gLaunch, elevDeg, v, nStages, Mproj, init };
    };
    const elevs = [];
    const nE = fast ? 5 : 8;
    for (let i = 0; i < nE; i++) elevs.push(P.eMin + (P.eMax - P.eMin) * i / (nE - 1));
    const tryStages = (v, e) => {
      const a = evalAt(e, v, 1, false);
      if (fast && a.obj < Infinity) return a;
      const b = evalAt(e, v, 2, false);
      return b.obj < a.obj ? b : a;
    };
    let best = { obj: Infinity };
    for (const e of elevs) { const r = tryStages(vMax, e); if (r.obj < best.obj) best = r; }
    if (best.obj < Infinity) {
      for (const f of (fast ? [0.85, 0.7] : [0.92, 0.84, 0.76, 0.68, 0.6])) {
        const r = evalAt(best.elevDeg, vMax * f, best.nStages, false); if (r.obj < best.obj) best = r;
      }
      const step = (P.eMax - P.eMin) / (nE - 1) / 2;
      for (const de of [-step, step]) {
        const e = clamp(best.elevDeg + de, P.eMin, P.eMax);
        const r = evalAt(e, best.v, best.nStages, false); if (r.obj < best.obj) best = r;
      }
    }
    if (!(best.obj < Infinity)) return fail(R, 'No launch angle and speed delivered the payload: the projectile cannot leave the atmosphere with enough energy');
    const fin = evalAt(best.elevDeg, best.v, best.nStages, true);
    if (!(fin.obj < Infinity)) return fail(R, 'The final flight did not close');
    const des = fin.des, sim = des.sim, veh = des.veh;
    const Mproj = fin.Mproj;
    R.launchMass = Mproj;
    R.extra = Object.assign(R.extra, { muzzle: fin.v, elev: fin.elevDeg, gLaunch: fin.gLaunch, nStages: fin.nStages, shell: fin.shell, ablator: fin.abl, diam: des.diam, limitedBy, vMax, vG });
    // launcher energy
    const KE = 0.5 * Mproj * fin.v * fin.v;
    const sled = P.sledFrac || 0;
    const Ein = KE * (1 + sled * (P.sledLoss == null ? 0.5 : P.sledLoss)) / P.eta;
    R.extra.KE = KE; R.extra.Ein = Ein;
    if (cfg.gas) burn(R, ctx, 'natgas', Ein / PROPS.natgas.eChem, 'ground');
    else electricity(R, ctx, Ein);
    veh.stages.forEach((sg, k) => {
      burn(R, ctx, sg.key, sg.prop);
      R.masses.push({ label: `Onboard stage ${veh.stages.length > 1 ? k + 1 + ' ' : ''}propellant`, kg: sg.prop }, { label: `Onboard stage ${veh.stages.length > 1 ? k + 1 + ' ' : ''}hardware (hardened)`, kg: sg.dry });
      R.cost.hardware += stageCost(sg.dry, 1.4 * hardeningFactor(fin.gLaunch));
    });
    R.masses.push({ label: 'Aeroshell & g-hardened structure', kg: fin.shell }, { label: 'Ablator burned off', kg: fin.abl }, { label: 'Payload', kg: ctx.payload.mass });
    R.cost.hardware += 25000 * Math.pow(fin.shell + fin.abl, 0.6);
    // the acceleration run itself, prepended to the flight record
    const tAcc = cfg.centripetal ? 0 : 2 * P.L / fin.v;
    R.traj = [];
    if (!cfg.centripetal) {
      for (let i = 0; i <= 6; i++) {
        const tt = -tAcc + tAcc * i / 6, vv = fin.v * i / 6;
        const sAlong = 0.5 * (fin.v / tAcc) * (tAcc * i / 6) ** 2 - P.L;
        R.traj.push({ t: tt, alt: (P.exitAlt + sAlong * Math.sin(fin.elevDeg * D2R)) / 1000, dr: sAlong * Math.cos(fin.elevDeg * D2R) / 1000, v: vv, vrel: vv, g: fin.gLaunch, q: 0, ph: 6, phase: cfg.accelLabel || 'Acceleration', x: (r0 + sAlong * Math.sin(fin.elevDeg * D2R)) / 1000, y: sAlong * Math.cos(fin.elevDeg * D2R) / 1000 });
      }
    } else {
      R.traj.push({ t: -0.01, alt: P.exitAlt / 1000, dr: 0, v: fin.v, vrel: fin.v, g: fin.gLaunch, q: 0, ph: 6, phase: 'Release from spin arm', x: r0 / 1000, y: 0 });
    }
    R.traj = R.traj.concat(sim.rec.map(p => ({ ...p, phase: ['Ballistic coast', 'Burn', 'Guided burn', 'Coast', 'Cutoff', 'End'][p.ph] })));
    R.events = [{ t: -tAcc, label: cfg.centripetal ? 'Spin-up in vacuum chamber (about an hour)' : `${cfg.accelLabel || 'Acceleration'} over ${(P.L / 1000).toLocaleString()} km` },
      { t: 0, label: `Exit at ${(fin.v / 1000).toFixed(2)} km/s, ${fin.elevDeg.toFixed(1)}° elevation, ${Math.round(fin.gLaunch).toLocaleString()} g` }].concat(sim.events.slice(1));
    R.peakG = Math.max(fin.gLaunch, sim.peakG); R.peakQ = sim.peakQ; R.peakHeat = sim.peakHeat;
    R.extra.dragLossAtmo = sim.losses.drag;
    R.time = sim.t + (sim.trim > 20 ? timeToApo(sim.el) : 0);
    R.orbitAfter = sim.state;
    R.dv = ledger(sim, { rotation: ctx.omega * RE, assist: fin.v });
    R.vehicle = veh;
    if (limitedBy === 'g') warn(R, `Exit speed held to ${(vMax / 1000).toFixed(2)} km/s by the payload's ${pay.gTol.toLocaleString()} g limit (launcher can do ${(P.vMax / 1000).toFixed(1)} km/s)`);
    if (sim.peakHeat > 50e6) warn(R, `Nose heat flux peaks at ${(sim.peakHeat / 1e6).toFixed(0)} MW/m² on exit: ablative nose required`);
    addDeparture(R, ctx);
    // energy audit: the launcher hands over ½·M·v² in the ground frame; Earth's rotation and the site altitude add the rest
    R._sim = sim;
    const L = flightLedger(ctx, sim, veh, 'orbit');
    burnLedger(ctx, L, ctx.dep, ctx.payload.mass);
    const launcherMech = 0.5 * Mproj * fin.v * fin.v;
    R._cas = Object.assign(L, {
      launcherMech, env: L.E0 - launcherMech, envLabel: "Earth's rotation & launch-site altitude",
      groundLabel: cfg.gas ? 'Gas charge (chemical energy)' : 'Grid electricity for the launcher',
      convNote: `Launcher losses (${Math.round(P.eta * 100)}% ${cfg.gas ? 'gas' : 'grid'}-to-kinetic, ${cfg.centripetal ? 'spin-arm' : 'sled and armature'} energy) plus the onboard stage’s combustion losses.`,
    });
    return R;
  }

  function finalize(R, ctx) {
    const pay = ctx.payload, D = ctx.D;
    if (!R.feasible) {
      for (const k of ['eff', 'effSite', 'etaOverall', 'energyPerKg', 'costPerKg', 'co2PerKg', 'payloadFraction', 'gMargin', 'timeToDest']) R[k] = null;
      R.cost.total = null; R.cascade = null;
      return R;
    }
    R.useful = pay.mass * D.usefulPerKg;
    R.E.total = R.E.onboard + R.E.ground + R.E.space + R.E.made;
    R.E.site = R.E.onboard + R.E.ground + R.E.space;
    R.effSite = R.useful / Math.max(1, R.E.site);
    R.eff = R.useful / Math.max(1, R.E.total);
    R.energyPerKg = R.E.total / pay.mass;
    R.cost.total = Object.values(R.cost).reduce((a, b) => (typeof b === 'number' ? a + b : a), 0);
    R.costPerKg = R.cost.total / pay.mass;
    R.co2PerKg = R.co2 / pay.mass;
    R.payloadFraction = pay.mass / Math.max(1, R.launchMass);
    R.gMargin = pay.gTol / Math.max(1, R.peakG);
    R.timeToDest = R.time + (D.trip || 0);
    buildCascade(R);
    delete R._sim;
    return R;
  }

  // ───────────────────────── the methods ─────────────────────────
  const FAMILIES = [
    { id: 'chem', name: 'Chemical rockets' },
    { id: 'assist', name: 'Assisted & beamed rockets' },
    { id: 'em', name: 'Electromagnetic launchers' },
    { id: 'kinetic', name: 'Gas guns & slings' },
    { id: 'tether', name: 'Tethers & elevators' },
  ];

  const METHODS = [
    {
      id: 'expendable', name: 'Expendable two-stage rocket', short: 'Expendable rocket', family: 'chem', trl: 9, cap: 30,
      blurb: 'The baseline: a kerosene/LOX two-stage rocket sized to the payload and thrown away after one flight.',
      how: ['Stage masses come from Tsiolkovsky, Δv = Isp·g₀·ln(m₀/m_f), with a structural coefficient that worsens as rockets shrink (fit between Falcon 9 and Electron).',
        'The ascent is flown, not estimated: vertical rise, pitch kick, zero-lift gravity turn, then closed-loop guidance on the upper stage. Gravity, drag and steering losses come out of the simulation and the vehicle is resized until it closes.'],
      params: [
        { k: 'tw1', label: 'Liftoff thrust/weight', min: 1.15, max: 2, step: 0.05, def: 1.35 },
        { k: 'tw2', label: 'Upper stage thrust/weight', min: 0.5, max: 2, step: 0.05, def: 0.9 },
        { k: 'isp2', label: 'Upper stage Isp (vac)', unit: 's', min: 300, max: 380, step: 1, def: 348 },
        { k: 'capex', label: 'Pad & integration facility', unit: '$M', min: 50, max: 2000, step: 10, def: 250, scale: 1e6 },
      ],
      run(ctx, P) {
        const R = runRocket(this, ctx, P, {
          stages: [stageSpec('kerolox', 'booster', { ispSL: 282, ispVac: 311, tw: P.tw1 }), stageSpec('kerolox', 'upper', { ispVac: P.isp2, tw: P.tw2 })],
        });
        if (!R.feasible) return R;
        const v = R.vehicle;
        R.cost.hardware += stageCost(v.stages[0].dry) + stageCost(v.stages[1].dry) + fairingCost(v.fairing);
        R.cost.ops += R.ops;
        amortize(R, ctx, P.capex, this.cap, 0.04, 'Launch pad & integration');
        return R;
      },
    },
    {
      id: 'reusable', name: 'Reusable-booster rocket', short: 'Reusable booster', family: 'chem', trl: 9, cap: 60,
      blurb: 'Falcon 9–style: the first stage keeps propellant back to fly home and land, then flies again.',
      how: ['The booster carries landing legs and grid fins (+15% structure) and holds back a share of its propellant for the entry and landing burns, so it must be bigger for the same payload.',
        'In exchange its cost is spread across many flights, plus refurbishment.'],
      params: [
        { k: 'reserve', label: 'Landing propellant reserve', unit: '%', min: 4, max: 20, step: 1, def: 9, scale: 0.01 },
        { k: 'reuse', label: 'Flights per booster', min: 2, max: 100, step: 1, def: 20 },
        { k: 'refurb', label: 'Refurbishment per flight', unit: '% of booster', min: 1, max: 40, step: 1, def: 8, scale: 0.01 },
        { k: 'capex', label: 'Pad, landing ship & refurb facility', unit: '$M', min: 50, max: 3000, step: 10, def: 400, scale: 1e6 },
      ],
      run(ctx, P) {
        const R = runRocket(this, ctx, P, {
          stages: [stageSpec('kerolox', 'booster', { ispSL: 282, ispVac: 311, tw: 1.4, mul: 1.15, add: 0.008, reserve: P.reserve }), stageSpec('kerolox', 'upper', { ispVac: 348, tw: 0.9 })],
        });
        if (!R.feasible) return R;
        const v = R.vehicle, c1 = stageCost(v.stages[0].dry);
        R.cost.hardware += c1 / P.reuse + stageCost(v.stages[1].dry) + 0.3 * fairingCost(v.fairing);
        R.cost.ops += R.ops + P.refurb * c1 + 0.5e6;
        amortize(R, ctx, P.capex, this.cap, 0.04, 'Pad, droneship & refurbishment');
        R.notes.push(`Booster lands with ${Math.round(v.stages[0].prop * P.reserve).toLocaleString()} kg of reserve propellant.`);
        return R;
      },
    },
    {
      id: 'fullreuse', name: 'Fully reusable methalox rocket', short: 'Fully reusable', family: 'chem', trl: 7, cap: 300,
      blurb: 'Starship-style: both stages return. The upper stage carries a heat shield, flaps and landing propellant.',
      how: ['Methane/LOX gives higher Isp (≈ 350–372 s) and cheap propellant. The ship pays for reuse with heat shield and landing mass (+5.5% structural coefficient, 4% landing reserve).',
        'Hardware is amortized over many flights; operations dominate the cost.'],
      params: [
        { k: 'reuse1', label: 'Booster flights', min: 5, max: 500, step: 5, def: 100 },
        { k: 'reuse2', label: 'Ship flights', min: 2, max: 300, step: 1, def: 30 },
        { k: 'capex', label: 'Launch tower, catch system & tank farm', unit: '$M', min: 200, max: 10000, step: 50, def: 2000, scale: 1e6 },
      ],
      run(ctx, P) {
        const R = runRocket(this, ctx, P, {
          noFairing: true,
          stages: [stageSpec('methalox', 'booster', { ispSL: 327, ispVac: 350, tw: 1.45, mul: 1.1, add: 0.008, reserve: 0.07 }),
            stageSpec('methalox', 'upper', { ispVac: 372, tw: 1.0, mul: 1.1, add: 0.055, reserve: 0.04 })],
        });
        if (!R.feasible) return R;
        const v = R.vehicle, c1 = stageCost(v.stages[0].dry, 0.7), c2 = stageCost(v.stages[1].dry, 0.7);
        R.cost.hardware += c1 / P.reuse1 + c2 / P.reuse2;
        R.cost.ops += R.ops + 0.03 * c1 + 0.05 * c2;
        amortize(R, ctx, P.capex, this.cap, 0.03, 'Launch tower & catch system');
        return R;
      },
    },
    {
      id: 'airlaunch', name: 'Air-launched rocket', short: 'Air launch', family: 'assist', trl: 9, cap: 24,
      blurb: 'Pegasus / LauncherOne: a carrier aircraft drops the rocket at 11 km and Mach 0.8.',
      how: ['The aircraft gives only ~240 m/s and 11 km of altitude, but it lets the first stage start above 75% of the atmosphere with a vacuum-like nozzle and skip the worst drag.',
        'The carrier burns tonnes of jet fuel per sortie and caps the rocket size (≈ 30 t for a 747, ≈ 250 t for Stratolaunch).'],
      params: [
        { k: 'dropAlt', label: 'Drop altitude', unit: 'km', min: 8, max: 14, step: 0.5, def: 11, scale: 1000 },
        { k: 'dropV', label: 'Drop speed', unit: 'm/s', min: 150, max: 300, step: 5, def: 236 },
        { k: 'capex', label: 'Carrier aircraft & integration', unit: '$M', min: 50, max: 1000, step: 10, def: 200, scale: 1e6 },
      ],
      run(ctx, P) {
        const R = runRocket(this, ctx, P, {
          startAlt: P.dropAlt, startV: P.dropV, mode: 'air', dvGuess: 8800, groundLabel: 'Carrier aircraft jet fuel',
          convNote: 'Rocket combustion losses, plus the carrier jet’s fuel energy beyond the height and speed it hands the rocket at the drop.',
          stages: [stageSpec('kerolox', 'booster', { ispSL: 282, ispVac: 311, tw: 1.3 }), stageSpec('kerolox', 'upper', { ispVac: 340, tw: 0.9 })],
        });
        if (!R.feasible) return R;
        const v = R.vehicle;
        let carrier;
        if (v.glow <= 30000) carrier = { name: 'Boeing 747-400 carrier', fuel: 25000 + 0.15 * v.glow, capex: P.capex };
        else if (v.glow <= 250000) carrier = { name: 'Stratolaunch-class carrier', fuel: 40000 + 0.15 * v.glow, capex: P.capex * 2.5 };
        else return fail(R, `Rocket gross mass ${(v.glow / 1000).toFixed(0)} t exceeds any carrier aircraft (≈ 250 t)`);
        burn(R, ctx, 'jetA', carrier.fuel, 'ground');
        R.extra.carrier = carrier;
        R.cost.hardware += stageCost(v.stages[0].dry) + stageCost(v.stages[1].dry) + fairingCost(v.fairing);
        R.cost.ops += R.ops + 250e3;
        amortize(R, ctx, carrier.capex, this.cap, 0.05, carrier.name);
        R.notes.push(`${carrier.name} burns about ${(carrier.fuel / 1000).toFixed(0)} t of jet fuel per sortie.`);
        R.events.unshift({ t: -2 * HOUR, label: `${carrier.name} takes off and climbs to the drop point` });
        return R;
      },
    },
    {
      id: 'rockoon', name: 'Balloon-launched rocket (rockoon)', short: 'Rockoon', family: 'assist', trl: 5, cap: 20,
      blurb: 'A helium balloon carries the rocket to 30 km, above 99% of the atmosphere, before ignition.',
      how: ['Starting at 30 km cuts drag losses to almost nothing and lets the first stage use a vacuum nozzle, but the balloon adds no speed.',
        'Zero-pressure balloons lift a few tonnes at most, so only small rockets qualify. Lift gas needed: m_He ≈ M·4/(28.96−4), independent of altitude.'],
      params: [
        { k: 'alt', label: 'Ignition altitude', unit: 'km', min: 15, max: 40, step: 1, def: 30, scale: 1000 },
        { k: 'lift', label: 'Balloon lift limit', unit: 't', min: 1, max: 10, step: 0.5, def: 3.6, scale: 1000 },
        { k: 'capex', label: 'Balloon launch site', unit: '$M', min: 5, max: 300, step: 5, def: 40, scale: 1e6 },
      ],
      run(ctx, P) {
        const R = runRocket(this, ctx, P, {
          startAlt: P.alt, startV: 0, mode: 'pad', dvGuess: 8900,
          stages: [stageSpec('kerolox', 'booster', { ispSL: 282, ispVac: 330, tw: 1.5 }), stageSpec('kerolox', 'upper', { ispVac: 345, tw: 1.0 })],
        });
        if (!R.feasible) return R;
        const v = R.vehicle;
        const envelope = 0.25 * v.glow + 100;
        const gross = v.glow + envelope;
        if (gross > P.lift) return fail(R, `Rocket plus balloon ${(gross / 1000).toFixed(1)} t exceeds the ${(P.lift / 1000).toFixed(1)} t balloon lift limit`);
        const he = 1.1 * gross * 4.0026 / (28.96 - 4.0026);
        burn(R, ctx, 'helium', he, 'ground');
        R.extra.helium = he; R.extra.envelope = envelope;
        R.cost.hardware += stageCost(v.stages[0].dry) + stageCost(v.stages[1].dry) + fairingCost(v.fairing) + 150 * envelope;
        R.cost.ops += R.ops * 0.6 + 300e3;
        amortize(R, ctx, P.capex, this.cap, 0.05, 'Balloon launch site');
        R.events.unshift({ t: -2.2 * HOUR, label: `Balloon ascent to ${(P.alt / 1000).toFixed(0)} km with ${Math.round(he)} kg of helium` });
        return R;
      },
    },
    {
      id: 'laser', name: 'Laser-thermal rocket (beamed energy)', short: 'Laser-thermal', family: 'assist', trl: 3, cap: 500,
      blurb: 'A ground laser array heats hydrogen in a heat exchanger on a single-stage vehicle (Kare\'s concept). No combustion onboard.',
      how: ['Hydrogen heated to ≈ 2,500 K gives Isp ≈ 780 s, roughly double kerosene, so one stage reaches orbit.',
        'Beam power needed: P = ½·ṁ·vₑ² / η_HX, held for the whole burn. Every joule comes from the grid through the laser and atmosphere.'],
      params: [
        { k: 'isp', label: 'Hydrogen exhaust Isp (vac)', unit: 's', min: 500, max: 950, step: 10, def: 780 },
        { k: 'etaHX', label: 'Heat-exchanger efficiency', unit: '%', min: 30, max: 90, step: 1, def: 60, scale: 0.01 },
        { k: 'etaLaser', label: 'Laser wall-plug efficiency', unit: '%', min: 10, max: 70, step: 1, def: 45, scale: 0.01 },
        { k: 'perW', label: 'Laser array cost', unit: '$/W', min: 0.2, max: 20, step: 0.1, def: 2 },
        { k: 'reuse', label: 'Vehicle flights', min: 1, max: 200, step: 1, def: 50 },
      ],
      run(ctx, P) {
        const R = runRocket(this, ctx, P, {
          dvGuess: 9600, groundLabel: 'Grid electricity for the laser array',
          convNote: 'Laser wall-plug, atmospheric transmission and heat-exchanger losses: grid energy that never becomes jet kinetic energy.',
          stages: [stageSpec('h2heat', 'upper', { ispSL: P.isp * 0.8, ispVac: P.isp, tw: 1.3, mul: 2.2, add: 0.04 })],
        });
        if (!R.feasible) return R;
        const v = R.vehicle, sg = v.stages[0];
        const ve = G0 * P.isp;
        const Pbeam = 0.5 * sg.mdot * ve * ve / P.etaHX;
        const Ebeam = 0.5 * sg.prop * ve * ve / P.etaHX;
        const etaAtm = 0.85;
        electricity(R, ctx, Ebeam / (P.etaLaser * etaAtm));
        R.extra.Pbeam = Pbeam; R.extra.Ebeam = Ebeam;
        const c1 = stageCost(sg.dry, 1.5);
        R.cost.hardware += c1 / P.reuse;
        R.cost.ops += R.ops * 0.7 + 0.05 * c1;
        amortize(R, ctx, 500e6 + P.perW * Pbeam / etaAtm, this.cap, 0.03, `Laser array ${(Pbeam / etaAtm / 1e6).toFixed(0)} MW + beam director`);
        const dr = R.traj.length ? R.traj[R.traj.length - 1].dr : 0;
        if (dr > 1200) warn(R, `Burn ends ${Math.round(dr).toLocaleString()} km downrange: needs a relay mirror or second beam station`);
        R.notes.push(`Peak beam power at the vehicle: ${(Pbeam / 1e6).toFixed(0)} MW for ${(sg.prop / sg.mdot).toFixed(0)} s.`);
        return R;
      },
    },
    {
      id: 'coilgun', name: 'Electromagnetic coilgun (mass driver)', short: 'Coilgun', family: 'em', trl: 4, cap: 2000,
      blurb: 'A 2 km evacuated coil track up a mountainside fires a hardened projectile that coasts out of the air and circularizes with a small motor.',
      how: ['Constant acceleration over track length L: a = v²/2L. A 2 km track at 7 km/s is about 1,250 g, so only hardened payloads survive.',
        'Leaving the muzzle at 4 km altitude, the slender projectile loses speed to drag (β = m/C_D·A matters) and heats at q̇ = 1.74×10⁻⁴·√(ρ/r_n)·v³ W/m². The angle and exit speed are optimized for the lightest projectile.'],
      params: [
        { k: 'L', label: 'Track length', unit: 'km', min: 0.2, max: 20, step: 0.1, def: 2, scale: 1000 },
        { k: 'vMax', label: 'Max exit speed', unit: 'km/s', min: 1, max: 10, step: 0.1, def: 7, scale: 1000 },
        { k: 'eta', label: 'Grid-to-kinetic efficiency', unit: '%', min: 10, max: 95, step: 1, def: 60, scale: 0.01 },
        { k: 'exitAlt', label: 'Muzzle altitude', unit: 'km', min: 0, max: 6, step: 0.1, def: 4, scale: 1000 },
        { k: 'perKm', label: 'Track cost', unit: '$M/km', min: 10, max: 2000, step: 10, def: 300, scale: 1e6 },
      ],
      fixed: { eMin: 6, eMax: 45, peak: 1.1, sledFrac: 0.25, sledLoss: 0.5 },
      run(ctx, P) {
        const R = runGun(this, ctx, P, { accelLabel: 'Coil track' });
        if (!R.feasible) return R;
        R.cost.ops += 60e3;
        const store = R.extra.Ein;
        amortize(R, ctx, 300e6 + P.perKm * P.L / 1000 + 0.003 * store, this.cap, 0.03, `${(P.L / 1000).toFixed(1)} km coil track + ${(store / 1e9).toFixed(1)} GJ pulsed storage`);
        return R;
      },
    },
    {
      id: 'startram', name: 'Maglev launch tube (StarTram Gen-1)', short: 'Maglev tube', family: 'em', trl: 2, cap: 3650,
      blurb: 'A 130 km evacuated superconducting maglev tunnel ending on a 6 km mountain peak. Gentle enough (≈ 30 g) for ordinary satellites.',
      how: ['Length buys gentleness: a = v²/2L, so 8.8 km/s over 130 km is only 30 g. The cost is a tunnel longer than most railways.',
        'The exit angle is limited to about 12° by the mountain, so the projectile skims a long path through thin air before coasting to apogee.'],
      params: [
        { k: 'L', label: 'Tube length', unit: 'km', min: 20, max: 1500, step: 10, def: 130, scale: 1000 },
        { k: 'vMax', label: 'Max exit speed', unit: 'km/s', min: 2, max: 10, step: 0.1, def: 8.8, scale: 1000 },
        { k: 'eta', label: 'Grid-to-kinetic efficiency', unit: '%', min: 30, max: 95, step: 1, def: 85, scale: 0.01 },
        { k: 'exitAlt', label: 'Exit altitude', unit: 'km', min: 0, max: 8, step: 0.5, def: 6, scale: 1000 },
        { k: 'capex', label: 'System cost (published Gen-1 estimate)', unit: '$B', min: 2, max: 100, step: 1, def: 20, scale: 1e9 },
      ],
      fixed: { eMin: 3, eMax: 12, peak: 1.0, sledFrac: 0, sledLoss: 0 },
      run(ctx, P) {
        const R = runGun(this, ctx, P, { accelLabel: 'Maglev tube' });
        if (!R.feasible) return R;
        R.cost.ops += 40e3;
        amortize(R, ctx, P.capex, this.cap, 0.02, `${(P.L / 1000).toFixed(0)} km maglev tunnel`);
        return R;
      },
    },
    {
      id: 'railgun', name: 'Railgun', short: 'Railgun', family: 'em', trl: 4, cap: 3000,
      blurb: 'Two rails and a sliding armature carrying mega-amp currents. Short barrel, brutal acceleration, rails erode every shot.',
      how: ['Lorentz force on the armature: F = ½·L′·I². Navy prototypes reached 2.5 km/s with 10 kg rounds; rail erosion limits speed and life.',
        'A 100 m barrel at 3 km/s means ≈ 6,000 g peak. The projectile still needs a substantial rocket to finish the job.'],
      params: [
        { k: 'L', label: 'Barrel length', unit: 'm', min: 10, max: 1000, step: 10, def: 100 },
        { k: 'vMax', label: 'Max muzzle speed', unit: 'km/s', min: 1, max: 7, step: 0.1, def: 3, scale: 1000 },
        { k: 'eta', label: 'Grid-to-kinetic efficiency', unit: '%', min: 5, max: 70, step: 1, def: 35, scale: 0.01 },
        { k: 'exitAlt', label: 'Muzzle altitude', unit: 'km', min: 0, max: 6, step: 0.1, def: 3, scale: 1000 },
        { k: 'wear', label: 'Rail & armature wear per shot', unit: '$k', min: 1, max: 500, step: 1, def: 40, scale: 1000 },
      ],
      fixed: { eMin: 10, eMax: 65, peak: 1.3, sledFrac: 0.15, sledLoss: 1 },
      run(ctx, P) {
        const R = runGun(this, ctx, P, { accelLabel: 'Rails' });
        if (!R.feasible) return R;
        R.cost.consumables += P.wear;
        R.cost.ops += 50e3;
        amortize(R, ctx, 400e6 + 0.005 * R.extra.Ein, this.cap, 0.04, `Railgun + ${(R.extra.Ein / 1e9).toFixed(1)} GJ pulsed power`);
        return R;
      },
    },
    {
      id: 'lgg', name: 'Light-gas gun (Quicklaunch-type)', short: 'Light-gas gun', family: 'kinetic', trl: 4, cap: 700,
      blurb: 'Burning natural gas heats hydrogen, whose light molecules push a projectile to 6 km/s down a 1.1 km floating barrel at sea.',
      how: ['Light molecules have a high sound speed, so the gas keeps up with the projectile. LLNL\'s SHARP gun reached 3 km/s with 5 kg in the 1990s.',
        'Pressure peaks early: peak acceleration ≈ 3× the average v²/2L, about 5,000 g at 6 km/s. Chemical-to-kinetic efficiency is low (≈ 12%).'],
      params: [
        { k: 'L', label: 'Barrel length', unit: 'm', min: 100, max: 3000, step: 50, def: 1100 },
        { k: 'vMax', label: 'Max muzzle speed', unit: 'km/s', min: 1, max: 8, step: 0.1, def: 6, scale: 1000 },
        { k: 'eta', label: 'Gas-to-kinetic efficiency', unit: '%', min: 3, max: 40, step: 1, def: 12, scale: 0.01 },
        { k: 'capex', label: 'Gun, barge & compressors', unit: '$M', min: 100, max: 5000, step: 50, def: 500, scale: 1e6 },
      ],
      fixed: { eMin: 10, eMax: 32, peak: 3.0, sledFrac: 0.1, sledLoss: 1, exitAlt: 0 },
      run(ctx, P) {
        const R = runGun(this, ctx, P, { gas: true, accelLabel: 'Gas barrel' });
        if (!R.feasible) return R;
        const h2 = 0.4 * R.launchMass;
        burn(R, ctx, 'hydrogen', h2, 'ground');
        R.cost.ops += 80e3;
        amortize(R, ctx, P.capex, this.cap, 0.05, 'Floating light-gas gun');
        R.notes.push(`Each shot vents about ${Math.round(h2).toLocaleString()} kg of hydrogen working gas.`);
        return R;
      },
    },
    {
      id: 'spin', name: 'Centrifugal sling (SpinLaunch-type)', short: 'Spin sling', family: 'kinetic', trl: 5, cap: 1500,
      blurb: 'A carbon-fibre arm spins in a vacuum chamber for an hour, then releases the projectile at 2.2 km/s through a port in the wall.',
      how: ['Release load is centripetal, a = v²/r: 2.2 km/s on a 45 m arm is about 11,000 g.',
        'Tip speed is capped by the arm material. A constant-stress tapered arm needs m_arm/m_tip = √π·x·e^(x²)·erf(x) with x = v/V_c and V_c = √(2σ/ρ·SF). The projectile exits at low altitude and still needs most of the Δv from its own rocket.'],
      params: [
        { k: 'armR', label: 'Arm radius', unit: 'm', min: 10, max: 150, step: 1, def: 45 },
        { k: 'vMax', label: 'Release speed', unit: 'km/s', min: 0.5, max: 4, step: 0.05, def: 2.2, scale: 1000 },
        { k: 'eta', label: 'Grid-to-kinetic efficiency', unit: '%', min: 20, max: 95, step: 1, def: 65, scale: 0.01 },
        { k: 'sigma', label: 'Arm composite strength', unit: 'GPa', min: 1, max: 8, step: 0.1, def: 3.5 },
        { k: 'capex', label: 'Accelerator facility', unit: '$M', min: 50, max: 3000, step: 10, def: 400, scale: 1e6 },
      ],
      fixed: { eMin: 35, eMax: 85, peak: 1.0, sledFrac: 0, sledLoss: 0, exitAlt: 1400, rhoArm: 1600, sf: 1.5 },
      run(ctx, P) {
        const R = runGun(this, ctx, P, { centripetal: true, material: true });
        if (!R.feasible) return R;
        R.cost.consumables += 3000;
        R.cost.ops += 50e3;
        amortize(R, ctx, P.capex, this.cap, 0.04, `Vacuum chamber & ${P.armR} m spin arm`);
        R.notes.push(`Arm material: tip speed is ${(P.vMax / R.extra.armVc).toFixed(2)}× its characteristic velocity; arm ≈ ${R.extra.armRatio.toFixed(1)}× the projectile mass.`);
        return R;
      },
    },
    {
      id: 'rotovator', name: 'Rotating tether (rotovator skyhook)', short: 'Rotovator', family: 'tether', trl: 2, cap: 365,
      blurb: 'An orbital slingshot. A 500 km tether spins end over end in orbit; its tip dips to 150 km moving slowly, catches a suborbital payload, and flings it on half a turn later.',
      how: ['At the bottom of its swing the tip moves at v_cm − V_tip, so a suborbital rocket only has to reach about 4.5 km/s. Released at the top, the payload leaves at v_cm + V_tip.',
        'The tether pays for this with its own orbital momentum, Δp = m·|Δv|, restored by solar-powered electrodynamic reboost (energy ≈ Δp·v_cm/η). Tether mass from Hoyt\'s taper law; ballast so one catch drops the tip by under 60 km.'],
      params: [
        { k: 'hCM', label: 'Tether centre-of-mass altitude', unit: 'km', min: 300, max: 2000, step: 10, def: 650, scale: 1000 },
        { k: 'arm', label: 'Arm length (centre to tip)', unit: 'km', min: 50, max: 1500, step: 10, def: 500, scale: 1000 },
        { k: 'vTip', label: 'Tip speed', unit: 'km/s', min: 0.5, max: 5, step: 0.1, def: 3, scale: 1000 },
        { k: 'sigma', label: 'Tether fibre strength (Zylon 5.8)', unit: 'GPa', min: 1, max: 60, step: 0.1, def: 5.8 },
        { k: 'etaRe', label: 'Reboost efficiency', unit: '%', min: 10, max: 90, step: 1, def: 50, scale: 0.01 },
      ],
      fixed: { rho: 1560, sf: 2, hwPerKg: 8000, launchPerKg: 2000, spaceW: 400 },
      run(ctx, P) { return runRotovator(this, ctx, P); },
    },
    {
      id: 'elevator', name: 'Space elevator', short: 'Space elevator', family: 'tether', trl: 1, cap: 120,
      blurb: 'A ribbon from the equator to a counterweight beyond geostationary orbit. Laser-powered climbers drive up it; release height sets the orbit.',
      how: ['Energy per kg to climb is the rise in effective potential Φ = −μ/r − ½ω²r²: 48.5 MJ/kg to GEO, delivered by beamed power at low efficiency.',
        'Released below GEO the payload falls into an ellipse; low orbits need a release near 30,000 km radius and a 2 km/s burn at perigee. Above GEO it is flung outward for free.',
        'Constant-stress taper: A_max/A_base = exp(ρ·SF·ΔΦ/σ). Only near-theoretical carbon nanotube or graphene ribbons give a buildable taper.'],
      params: [
        { k: 'sigma', label: 'Ribbon tensile strength', unit: 'GPa', min: 2, max: 130, step: 1, def: 50 },
        { k: 'rho', label: 'Ribbon density', unit: 'kg/m³', min: 900, max: 8000, step: 10, def: 1300 },
        { k: 'top', label: 'Counterweight altitude', unit: 'km', min: 40000, max: 150000, step: 1000, def: 100000, scale: 1000 },
        { k: 'eta', label: 'Grid-to-climber efficiency', unit: '%', min: 2, max: 50, step: 1, def: 12, scale: 0.01 },
        { k: 'speed', label: 'Climb speed', unit: 'km/h', min: 50, max: 1000, step: 10, def: 200 },
      ],
      fixed: { sf: 2, climberFrac: 0.5, perKgRibbon: 10000, baseCapex: 10e9 },
      run(ctx, P) { return runElevator(this, ctx, P); },
    },
  ];
  // gun-family defaults that are fixed per method (merged into P)
  for (const M of METHODS) M.fixed = M.fixed || {};

  // ───────────────────────── rotovator ─────────────────────────
  function runRotovator(M, ctx, P) {
    const R = newResult(M, ctx), D = ctx.D, pay = ctx.payload;
    const rcm = RE + P.hCM, vcm = vCirc(rcm), L = P.arm, Vt = P.vTip, Om = Vt / L;
    const rc = rcm - L, catchAlt = rc - RE;
    if (catchAlt < 100e3) return fail(R, `Tip dips to ${(catchAlt / 1000).toFixed(0)} km: inside the atmosphere. Raise the orbit or shorten the arm`);
    const vCatch = vcm - Vt;
    if (vCatch < 1500) return fail(R, 'Tip speed nearly cancels the orbital speed: the catch would be almost a standstill above the atmosphere');
    const n = vCirc(rcm) / rcm;
    // scan release phase
    let best = null;
    for (let deg = 0; deg <= 360; deg += 2) {
      const psi = deg * D2R; // angle swept relative to local vertical
      const tRel = psi / Math.max(1e-9, Om - n);
      const nu = n * tRel; // CM orbital angle
      const erx = Math.cos(nu), ery = Math.sin(nu), etx = -ery, ety = erx;
      const rx = L * (-Math.cos(psi) * erx - Math.sin(psi) * etx), ry = L * (-Math.cos(psi) * ery - Math.sin(psi) * ety);
      const vrelR = Om * L * Math.sin(psi), vrelT = -Om * L * Math.cos(psi);
      const px = rcm * erx + rx, py = rcm * ery + ry;
      const vx = vcm * etx + vrelR * erx + vrelT * etx, vy = vcm * ety + vrelR * ery + vrelT * ety;
      const el = elems(px, py, vx, vy);
      if (el.rp < RE + 90e3 && D.key !== 'LEO' && el.eps < 0) continue;
      const dv = dvFromOrbitToDest(el, D);
      if (!best || dv < best.dv) best = { deg, dv, el, px, py, vx, vy, tRel };
    }
    const kick = sizeKick(pay.mass, best.dv, 320);
    if (!kick) return fail(R, 'Post-release kick stage does not close');
    const stack = pay.mass + kick.total;
    // suborbital rocket to the catch point (reusable-booster technology)
    const tgt = { kind: 'catch', r: rc, vh: vCatch, eps: 0.5 * vCatch * vCatch - MU / rc };
    const spec = { stages: [stageSpec('kerolox', 'booster', { ispSL: 282, ispVac: 311, tw: 1.4, mul: 1.15, add: 0.008, reserve: 0.09 }), stageSpec('kerolox', 'upper', { ispVac: 348, tw: 0.9 })],
      fairing: fairingMass(stack), pStart: P0, cdTab: CD_ROCKET, aMax: ctx.aMax, shell: 0 };
    const init = { x: RE, y: 0, vx: 0, vy: ctx.omega * RE, omega: ctx.omega, mode: 'pad', epsG: ctx.D.epsGround };
    const des = designRocket(spec, stack, init, tgt, { gp: 2.6, gpList: ctx.fast ? KICKS_FAST : KICKS, dvGuess: 6000 });
    if (!des.ok) return fail(R, des.reason || 'Suborbital rocket could not reach the catch point');
    const veh = des.veh, sim = des.sim;
    // tether facility
    const vc = charVelocity(P.sigma * 1e9, P.rho, P.sf);
    const tr = tetherMassRatio(Vt, vc);
    if (tr > 2000) return fail(R, `Tip speed ${(Vt / 1000).toFixed(1)} km/s is ${(Vt / vc).toFixed(1)}× the fibre's characteristic velocity: tether would weigh ${Math.round(tr)}× the payload`);
    const dvAllow = Math.max(1, vcm * Math.max(5e3, catchAlt - 90e3) / (4 * rcm));
    const Mfac = Math.max(tr * stack + 5 * stack + 2000, stack * Vt / dvAllow);
    const dp = stack * Math.hypot(best.vx, best.vy - vCatch);
    const Ere = dp * vcm / P.etaRe;
    electricity(R, ctx, Ere, 'space');
    const Pspace = Ere * ctx.econ.perYear / (YEAR * 0.6);
    // rocket costs (reusable booster economics)
    veh.stages.forEach((sg, k) => { burn(R, ctx, sg.key, sg.prop); R.masses.push({ label: `Suborbital stage ${k + 1} propellant`, kg: sg.prop }, { label: `Suborbital stage ${k + 1} structure`, kg: sg.dry }); });
    R.masses.push({ label: 'Payload fairing', kg: spec.fairing }, { label: 'Post-release kick stage', kg: kick.total }, { label: 'Payload', kg: pay.mass });
    burn(R, ctx, 'storable', kick.prop);
    const c1 = stageCost(veh.stages[0].dry);
    R.cost.hardware += c1 / 20 + stageCost(veh.stages[1].dry) + 0.3 * fairingCost(spec.fairing) + stageCost(kick.dry, 1.6);
    R.cost.ops += opsCost(veh.glow) + 0.08 * c1 + 0.5e6 + 150e3;
    amortize(R, ctx, Mfac * (P.hwPerKg + P.launchPerKg), M.cap, 0.03, `Tether facility ${(Mfac / 1000).toFixed(1)} t in orbit`);
    amortize(R, ctx, Pspace * P.spaceW, 1e9, 0.02, `${(Pspace / 1e3).toFixed(0)} kW reboost solar array`);
    R.launchMass = veh.glow;
    R.vehicle = veh;
    rocketTrajToResult(R, sim, ['Coast', 'Gravity turn', 'Guided ascent', 'Coast to tip', 'Cutoff', 'Catch']);
    const tCatch = sim.t + timeToApoNear(sim.el);
    // swing and release segment for the record (inertial)
    const t0 = R.traj.length ? R.traj[R.traj.length - 1].t : 0;
    const ang0 = R.traj.length ? Math.atan2(R.traj[R.traj.length - 1].y, R.traj[R.traj.length - 1].x) : 0;
    const swing = [];
    for (let i = 0; i <= 24; i++) {
      const psi = best.deg * D2R * i / 24, tt = psi / Math.max(1e-9, Om - n), nu = n * tt;
      const erx = Math.cos(nu + ang0), ery = Math.sin(nu + ang0), etx = -ery, ety = erx;
      const px = rcm * erx + L * (-Math.cos(psi) * erx - Math.sin(psi) * etx), py = rcm * ery + L * (-Math.cos(psi) * ery - Math.sin(psi) * ety);
      const rr = Math.hypot(px, py), vv = Math.hypot(vcm + Om * L * (-Math.cos(psi)), Om * L * Math.sin(psi));
      swing.push({ t: tCatch + tt, alt: (rr - RE) / 1000, dr: (Math.atan2(py, px) - ctx.omega * (tCatch + tt)) * RE / 1000, v: vv, vrel: vv, g: Vt * Vt / L / G0, q: 0, ph: 7, phase: 'Riding the tether', x: px / 1000, y: py / 1000 });
    }
    R.traj = R.traj.concat(swing);
    { // the payload's orbit after release, in the same inertial frame as the record
      const c = Math.cos(ang0), sn = Math.sin(ang0);
      R.orbitAfter = { x: c * best.px - sn * best.py, y: sn * best.px + c * best.py, vx: c * best.vx - sn * best.vy, vy: sn * best.vx + c * best.vy };
    }
    R.events.push({ t: tCatch, label: `Tether tip catches the payload at ${(catchAlt / 1000).toFixed(0)} km, ${(vCatch / 1000).toFixed(2)} km/s` },
      { t: tCatch + best.tRel, label: `Release after ${best.deg}° of swing at ${(Math.hypot(best.vx, best.vy) / 1000).toFixed(2)} km/s` });
    if (best.dv > 1) R.events.push({ t: tCatch + best.tRel + 1200, label: `Kick burn ${Math.round(best.dv)} m/s → ${D.short}` });
    const gT = Vt * Vt / L / G0;
    R.peakG = Math.max(sim.peakG, gT + 0.3);
    if (gT > pay.gTol) fail(R, `Tether tip centripetal load ${gT.toFixed(1)} g exceeds the payload limit`);
    R.time = tCatch + best.tRel + 3600;
    R.dv = ledger(sim, { rotation: ctx.omega * RE, assist: Math.hypot(best.vx, best.vy) - vCatch, kick: best.dv });
    R.extra = { catchAlt, vCatch, vRelease: Math.hypot(best.vx, best.vy), releaseDeg: best.deg, kickDv: best.dv, Mfac, tetherRatio: tr, vc, Ere, Pspace, rcm, L, releaseEl: best.el };
    R.notes.push(`Facility mass ${(Mfac / 1000).toFixed(1)} t (${Math.round(Mfac / stack)}× the payload stack). Reboost needs ${(Ere / 1e9).toFixed(1)} GJ of solar energy per catch.`);
    R.notes.push('Catching a payload at hypersonic relative speed with metre-level timing has never been demonstrated.');
    // energy audit: rocket to the tip, the tether's orbital energy handed to the stack, then the kick burn
    const LG = flightLedger(ctx, sim, veh, 'catch');
    const tetherMech = stack * (best.el.eps - LG.stack.eps);
    LG.stack = { mass: stack, eps: best.el.eps };
    burnLedger(ctx, LG, kick, pay.mass);
    R._cas = Object.assign(LG, { launcherMech: tetherMech, env: 0, groundLabel: '', convNote: 'Rocket combustion losses, plus the reboost system’s losses in restoring the tether’s orbit (solar energy that never becomes orbital energy).' });
    R.extra.tetherMech = tetherMech;
    return R;
  }

  // ───────────────────────── space elevator ─────────────────────────
  function runElevator(M, ctx, P) {
    const R = newResult(M, ctx), D = ctx.D, pay = ctx.payload;
    const sd = P.sigma * 1e9 / P.sf; // design stress
    const k = P.rho / sd;
    const rTop = RE + P.top;
    const taperGEO = Math.exp(k * (phiEff(R_GEO) - phiEff(RE)));
    R.extra.taper = taperGEO;
    if (!(taperGEO < 1e4)) return fail(R, `Ribbon taper ratio ${taperGEO > 1e30 ? '> 10³⁰' : taperGEO.toExponential(1)}: no ${P.sigma} GPa material can hold its own weight to GEO`);
    if (taperGEO > 100) warn(R, `Taper ratio ${Math.round(taperGEO)}: the ribbon would be absurdly heavy`);
    // release radius
    const omg = OMEGA;
    const relState = r => {
      const v = omg * r;
      return elems(r, 0, 0, v);
    };
    let rRel, kickDv = 0;
    if (D.key === 'LEO') {
      let a = RE + 1000e3, b = R_GEO;
      for (let i = 0; i < 80; i++) { const mid = 0.5 * (a + b); const el = relState(mid); if (el.rp < D.rPark) a = mid; else b = mid; }
      rRel = 0.5 * (a + b);
      const el = relState(rRel);
      kickDv = speedAt(el.eps, el.rp) - vCirc(el.rp);
    } else if (D.key === 'GEO') {
      rRel = R_GEO;
    } else {
      const f = r => (D.key === 'TLI' ? 0.5 * (omg * r) ** 2 - MU / r + MU / (r + R_MOON) : 0.5 * (omg * r) ** 2 - MU / r - D.C3 / 2);
      if (f(rTop) < 0) { rRel = rTop; const v = omg * rTop; kickDv = Math.max(0, Math.sqrt((D.key === 'TLI' ? 2 * MU / rTop - 2 * MU / (rTop + R_MOON) : D.C3 + 2 * MU / rTop)) - v); }
      else {
        let a = R_GEO, b = rTop;
        for (let i = 0; i < 80; i++) { const mid = 0.5 * (a + b); if (f(mid) < 0) a = mid; else b = mid; }
        rRel = 0.5 * (a + b);
      }
    }
    if (rRel > rTop + 1) return fail(R, 'Release point is above the counterweight');
    const kick = sizeKick(pay.mass, kickDv, 320);
    const stack = pay.mass + (kick ? kick.total : 0);
    const climber = P.climberFrac * stack;
    const lift = stack + climber;
    const dPhi = phiEff(Math.min(rRel, R_GEO)) - phiEff(RE);
    const Emech = lift * dPhi;
    electricity(R, ctx, Emech / P.eta);
    burn(R, ctx, 'storable', kick ? kick.prop : 0);
    // ribbon & counterweight for this design load
    const A0 = lift * G0 / sd;
    let mass = 0; const N = 4000;
    for (let i = 0; i < N; i++) {
      const r = RE + (rTop - RE) * (i + 0.5) / N;
      mass += P.rho * A0 * Math.exp(k * (phiEff(r) - phiEff(RE))) * (rTop - RE) / N;
    }
    const Atop = A0 * Math.exp(k * (phiEff(rTop) - phiEff(RE)));
    const cw = rTop > R_GEO * 1.02 ? sd * Atop / (OMEGA * OMEGA * rTop - MU / (rTop * rTop)) : Infinity;
    if (!isFinite(cw)) return fail(R, 'Counterweight must sit well above GEO');
    const ribbonTotal = mass + cw;
    const climbT = (rRel - RE) / (P.speed / 3.6);
    R.extra = { taper: taperGEO, rRel, kickDv, climber, ribbon: mass, counterweight: cw, climbT, Emech, dPhi, vRel: omg * rRel, vc: charVelocity(P.sigma * 1e9, P.rho, P.sf) };
    R.cost.hardware += 1500 * climber / 50 + (kick ? stageCost(kick.dry, 1.6) : 0);
    R.cost.ops += 200e3;
    amortize(R, ctx, P.baseCapex + ribbonTotal * P.perKgRibbon, M.cap, 0.02, `Ribbon ${(mass / 1000).toFixed(0)} t + counterweight ${(cw / 1000).toFixed(0)} t, anchor & laser stations`);
    R.launchMass = lift;
    R.masses.push({ label: 'Climber (reused)', kg: climber });
    if (kick && kick.total) R.masses.push({ label: 'Kick stage', kg: kick.total });
    R.masses.push({ label: 'Payload', kg: pay.mass });
    R.peakG = 1.0;
    R.time = climbT + (kickDv > 0 ? 6 * HOUR : 0);
    // trajectory record: climb (inertial positions rotate with Earth)
    const tr = [];
    for (let i = 0; i <= 60; i++) {
      const r = RE + (rRel - RE) * i / 60, t = climbT * i / 60, ang = OMEGA * t;
      tr.push({ t, alt: (r - RE) / 1000, dr: 0, v: OMEGA * r, vrel: P.speed / 3.6, g: Math.abs(MU / (r * r) - OMEGA * OMEGA * r) / G0, q: 0, ph: 8, phase: 'Climbing the ribbon', x: r / 1000, y: 0, frame: 'earth' }); void ang;
    }
    R.traj = tr;
    R.orbitAfter = { x: rRel, y: 0, vx: 0, vy: OMEGA * rRel }; // drawn with the ribbon fixed along +x
    R.events = [{ t: 0, label: 'Climber departs the equatorial anchor' }, { t: climbT * 100e3 / (rRel - RE), label: 'Passes the Kármán line (100 km)' }].concat(rRel >= R_GEO * 1.001 ? [{ t: climbT * (R_GEO - RE) / (rRel - RE), label: 'Passes geostationary altitude: apparent gravity reverses' }] : []).concat([
      { t: climbT, label: `Release at ${((rRel - RE) / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} km altitude, ${(OMEGA * rRel / 1000).toFixed(2)} km/s` }]);
    if (kickDv > 1) R.events.push({ t: climbT + 6 * HOUR, label: `Kick burn ${Math.round(kickDv)} m/s` });
    R.dv = { onboard: kickDv, gravity: 0, drag: 0, steering: 0, trim: 0, start: OMEGA * RE, final: OMEGA * rRel, rotation: OMEGA * RE, assist: OMEGA * rRel - OMEGA * RE, kick: kickDv };
    R.notes.push(`Climb takes ${(climbT / DAY).toFixed(1)} days at ${P.speed} km/h. ${(dPhi / 1e6).toFixed(1)} MJ/kg of effective-potential rise.`);
    if (P.sigma > 20) warn(R, `${P.sigma} GPa at ${P.rho} kg/m³ is far beyond any fibre made at length (best ≈ 7 GPa)`);
    // energy audit. In the inertial frame the stack gains more energy than the climb work: the ribbon's Coriolis
    // reaction hands over some of Earth's rotational energy. Above GEO the climber must brake, and that energy is lost.
    const epsG = ctx.D.epsGround, epsRel = 0.5 * Math.pow(OMEGA * rRel, 2) - MU / rRel;
    const mechLift = lift * (epsRel - epsG);
    const Ebrake = rRel > R_GEO ? lift * (phiEff(R_GEO) - phiEff(rRel)) : 0;
    const Erot = mechLift - Emech + Ebrake;
    const LG = { jet: 0, exhaust: 0, drag: 0, hardware: climber * (epsRel - epsG), reserve: 0, stack: { mass: stack, eps: epsRel } };
    burnLedger(ctx, LG, kick, pay.mass);
    R._cas = Object.assign(LG, {
      launcherMech: mechLift - Erot, env: Erot, envLabel: "Earth's rotation (through the ribbon)", groundLabel: 'Grid electricity for the climber’s power beam',
      convNote: `Power-beaming chain (${Math.round(P.eta * 100)}% grid-to-climber)${Ebrake > 0 ? ', plus braking above GEO' : ''}, and the kick stage’s combustion losses.`,
    });
    R.extra.Erot = Erot; R.extra.Ebrake = Ebrake;
    return R;
  }

  // ───────────────────────── scoring ─────────────────────────
  const METRICS = [
    { k: 'etaOverall', label: 'Overall efficiency', better: 'high', log: true, unit: '%' },
    { k: 'costPerKg', label: 'Cost per kg', better: 'low', log: true, unit: '$/kg' },
    { k: 'payloadFraction', label: 'Payload fraction', better: 'high', log: true, unit: '%' },
    { k: 'trl', label: 'Readiness (TRL)', better: 'high', log: false },
    { k: 'co2PerKg', label: 'CO₂ per kg', better: 'low', log: true, unit: 'kg' },
    { k: 'timeToDest', label: 'Time to destination', better: 'low', log: true, unit: 's' },
  ];
  const DEFAULT_WEIGHTS = { etaOverall: 30, costPerKg: 30, payloadFraction: 10, trl: 20, co2PerKg: 10, timeToDest: 0 };
  // How "efficient" is judged. The first is the engineering definition and the default.
  const DEFINITIONS = [
    { id: 'overall', label: 'Overall efficiency', short: 'η overall', weights: { etaOverall: 1 },
      blurb: 'Useful energy out divided by energy in: the payload’s gain in orbital energy over every joule spent at the site. The product of the conversion, propulsive, aerodynamic and payload efficiencies.' },
    { id: 'payload', label: 'Payload fraction', short: 'payload fraction', weights: { payloadFraction: 1 },
      blurb: 'The launch-vehicle designer’s figure of merit since Tsiolkovsky: payload mass over the mass that leaves the ground.' },
    { id: 'cost', label: 'Cost per kilogram', short: 'cost per kg', weights: { costPerKg: 1 },
      blurb: 'The economist’s figure of merit (Koelle’s TRANSCOST): what it costs to deliver each kilogram, with infrastructure amortized.' },
    { id: 'trade', label: 'Weighted trade study', short: 'weighted score', weights: null,
      blurb: 'A multi-attribute trade study: your own weights across efficiency, cost, mass, readiness, emissions and time.' },
  ];
  function score(results, weights) {
    const ok = results.filter(r => r.feasible);
    const norm = {};
    for (const M of METRICS) {
      if (M.k === 'trl') continue;
      const vals = ok.map(r => r[M.k]).filter(v => v > 0 && isFinite(v));
      if (!vals.length) continue;
      const f = v => (M.log ? Math.log(Math.max(v, 1e-12)) : v);
      norm[M.k] = { lo: Math.min(...vals.map(f)), hi: Math.max(...vals.map(f)), f };
    }
    let wsum = 0;
    for (const M of METRICS) wsum += weights[M.k] || 0;
    for (const r of results) {
      r.scores = {};
      if (!r.feasible) { r.score = 0; continue; }
      let s = 0;
      for (const M of METRICS) {
        let sc;
        if (M.k === 'trl') sc = (r.trl - 1) / 8;
        else {
          const N = norm[M.k];
          if (!N || N.hi - N.lo < 1e-9) sc = 1;
          else { const u = (N.f(r[M.k]) - N.lo) / (N.hi - N.lo); sc = M.better === 'high' ? u : 1 - u; }
        }
        r.scores[M.k] = sc;
        s += (weights[M.k] || 0) * sc;
      }
      r.score = wsum > 0 ? 100 * s / wsum : 0;
    }
    return results.slice().sort((a, b) => (b.feasible - a.feasible) || (b.score - a.score));
  }

  // ───────────────────────── entry point ─────────────────────────
  function paramDefaults(M) {
    const P = {};
    for (const p of M.params) P[p.k] = p.def;
    return P;
  }
  function resolveParams(M, ui) {
    const P = Object.assign({}, M.fixed);
    for (const p of M.params) {
      const v = ui && ui[p.k] != null ? ui[p.k] : p.def;
      P[p.k] = v * (p.scale || 1);
    }
    return P;
  }
  function makeContext(input) {
    const payload = Object.assign({ mass: 200, gTol: 12000, density: 800 }, input.payload);
    const mission = Object.assign({ dest: 'LEO', alt: 500, lat: 28.5, assist: false }, input.mission);
    const econ = Object.assign({ elecPrice: 0.08, gridCO2: 0.35, perYear: 100, years: 20 }, input.econ);
    const D = destination(mission);
    const dep = sizeKick(payload.mass, D.dvDep, 320) || { prop: 0, dry: 0, total: 0 };
    return {
      payload, mission, econ, D, dep, PLeff: payload.mass + dep.total, omega: OMEGA * Math.cos(mission.lat * D2R),
      aMax: Math.max(payload.gTol, 1.5) * G0, fast: !!input.fast,
    };
  }
  function runMethod(id, ctx, uiParams) {
    const M = METHODS.find(m => m.id === id);
    const P = resolveParams(M, uiParams);
    let R;
    try { R = M.run(ctx, P); } catch (e) { R = newResult(M, ctx); fail(R, 'Solver error: ' + e.message); R.error = e; }
    R.params = P;
    if (R.feasible && ctx.dep.total > 0 && !['rotovator', 'elevator'].includes(id)) R.extra.departure = ctx.dep;
    return finalize(R, ctx);
  }

  return {
    MU, RE, OMEGA, G0, R_GEO, R_MOON, DAY, YEAR, HOUR,
    atm, us76, elems, vCirc, keplerPropagate, dvToCircular, dvToGEO, timeToApo, phiEff, tetherMassRatio, charVelocity, erf,
    destination, sizeStage, sizeKick, buildVehicle, fly, designRocket, propulsiveEfficiency,
    PROPS, STRUCT, FAMILIES, METHODS, METRICS, DEFAULT_WEIGHTS, DEFINITIONS, score, makeContext, runMethod, paramDefaults, resolveParams,
    CD_ROCKET, CD_SLENDER,
  };
}));
