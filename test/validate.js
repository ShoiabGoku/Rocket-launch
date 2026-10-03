// Closed-form and literature checks for the LAUNCHBENCH engine.  node test/validate.js
const LB = require('../engine.js');
let pass = 0, failN = 0;
function check(name, got, want, tol, unit = '') {
  const ok = Math.abs(got - want) <= tol;
  (ok ? pass++ : failN++);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${+got.toPrecision(6)} ${unit} (expected ${want} ± ${tol})`);
}
function truthy(name, cond, detail = '') { (cond ? pass++ : failN++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ': ' + detail : ''}`); }

// 1. Atmosphere vs US Standard Atmosphere 1976 tables
check('ρ at sea level', LB.atm(0).rho, 1.2250, 0.0005, 'kg/m³');
check('ρ at 11 km (geometric)', LB.atm(11000).rho, 0.36480, 0.001, 'kg/m³');
check('ρ at 20 km (geometric)', LB.atm(20000).rho, 0.088910, 0.0004, 'kg/m³');
check('ρ at 50 km', LB.atm(50000).rho, 1.0269e-3, 2e-5, 'kg/m³');
check('ρ at 80 km', LB.atm(80000).rho, 1.846e-5, 0.6e-6, 'kg/m³');
check('ρ at 400 km', LB.atm(400000).rho, 2.803e-12, 1e-15, 'kg/m³');
check('speed of sound at 0 km', LB.atm(0).a, 340.29, 0.1, 'm/s');

// 2. Orbital mechanics
check('circular speed at 400 km', LB.vCirc(LB.RE + 400e3), 7668.6, 1, 'm/s');
check('geostationary radius', LB.R_GEO / 1000, 42164, 2, 'km');
const leo300 = LB.RE + 300e3;
const dGEO = LB.destination({ dest: 'GEO', alt: 300, lat: 0 });
check('LEO 300 km → GEO, equatorial (Hohmann)', dGEO.dvDep, 3893, 10, 'm/s');
const dGEO28 = LB.destination({ dest: 'GEO', alt: 300, lat: 28.5 });
check('LEO 300 km → GEO from 28.5° (combined plane change)', dGEO28.dvDep, 4240, 40, 'm/s');
const dTLI = LB.destination({ dest: 'TLI', alt: 300, lat: 28.5 });
check('trans-lunar injection from 300 km (vis-viva, apogee at lunar distance)', dTLI.dvDep, Math.sqrt(LB.MU * (2 / leo300 - 2 / (leo300 + LB.R_MOON))) - LB.vCirc(leo300), 0.5, 'm/s');
check('…which is the textbook ≈ 3.1 km/s', dTLI.dvDep, 3110, 40, 'm/s');
check('escape speed at the equator', Math.sqrt(2 * LB.MU / LB.RE), 11180, 2, 'm/s');

// 3. Tsiolkovsky sizing reproduces the rocket equation
const s = LB.sizeStage(1000, 3000, 300, { law: 'upper', reserve: 0 });
const dvBack = 300 * LB.G0 * Math.log((1000 + s.prop + s.dry) / (1000 + s.dry));
check('sizeStage closes the rocket equation', dvBack, 3000, 0.01, 'm/s');

// 4. Space elevator energetics: effective-potential rise to GEO
check('climb energy surface → GEO', (LB.phiEff(LB.R_GEO) - LB.phiEff(LB.RE)) / 1e6, 48.4, 0.3, 'MJ/kg');
// release from the ribbon at GEO radius is exactly circular
const elG = LB.elems(LB.R_GEO, 0, 0, LB.OMEGA * LB.R_GEO);
check('elevator release at GEO is circular (e)', elG.e, 0, 1e-6);
// free-escape altitude: ½ω²r² = μ/r  → r ≈ 53,000 km radius (≈ 46,700 km altitude)
const rEsc = Math.cbrt(2 * LB.MU / (LB.OMEGA * LB.OMEGA));
check('elevator free-escape altitude', (rEsc - LB.RE) / 1000, 46700, 150, 'km');

// 5. Tether mass ratio (Hoyt/Moravec): √π·x·e^(x²)·erf(x) at x = 1
check('tapered tether mass ratio at V_tip = V_c', LB.tetherMassRatio(1, 1), 4.06, 0.01);
check('erf(1)', LB.erf(1), 0.842701, 2e-6);

// 6. Integrator: a vacuum coast must conserve specific energy
{
  const veh = { stages: [], payload: 100, fairing: 0, shell: 0, area: 1e-12, shellArea: 0, cdTab: LB.CD_ROCKET, aMax: 1e9 };
  const r0 = LB.RE + 400e3;
  const init = { x: r0, y: 0, vx: 0, vy: 7900, omega: 0, mode: 'coast' };
  const sim = LB.fly(veh, init, { kind: 'orbit', r: r0, vh: 9000, eps: 1e12 }, 0, { tMax: 3000 });
  const e0 = 0.5 * 7900 * 7900 - LB.MU / r0;
  check('RK4 vacuum coast conserves energy over 50 min', (sim.el.eps - e0) / Math.abs(e0) * 1e6, 0, 5, 'ppm');
}

// 7. Ascent Δv ledger closes: Δv_ideal = Δ|v| + gravity + drag + steering
{
  const ctx = LB.makeContext({ payload: { mass: 5000, gTol: 6 }, mission: { dest: 'LEO', alt: 400, lat: 28.5 } });
  const R = LB.runMethod('expendable', ctx, {});
  const d = R.dv;
  const closure = (d.onboard - d.trim) - (d.final - d.start + d.gravity + d.drag + d.steering);
  check('Δv ledger closure (expendable, 5 t to 400 km)', closure, 0, 25, 'm/s');
  check('total Δv to a 400 km orbit from 28.5° (literature ≈ 9.3–9.6 km/s)', d.onboard, 9400, 250, 'm/s');
  truthy('payload fraction of a two-stage kerolox rocket is 2.5–5%', R.payloadFraction > 0.025 && R.payloadFraction < 0.05, (R.payloadFraction * 100).toFixed(2) + '%');
}

// 8. Falcon 9-class benchmark: 22.8 t to LEO with F9-like engines lands near 550 t gross
{
  const ctx = LB.makeContext({ payload: { mass: 22800, gTol: 6 }, mission: { dest: 'LEO', alt: 200, lat: 28.5 } });
  const R = LB.runMethod('expendable', ctx, {});
  check('expendable kerolox sized for 22.8 t → GLOW (F9: 549 t)', R.launchMass / 1000, 549, 90, 't');
  check('…and its cost per kg (F9 expendable ≈ $2,300–3,000/kg)', R.costPerKg, 2600, 900, '$/kg');
}

// 9. Gun physics: g-load is v²/2L
{
  const ctx = LB.makeContext({ payload: { mass: 200, gTol: 50000 }, mission: { dest: 'LEO', alt: 500, lat: 28.5 } });
  const R = LB.runMethod('startram', ctx, {});
  const P = R.params;
  check('maglev launch load equals v²/2L', R.extra.gLaunch, R.extra.muzzle ** 2 / (2 * P.L) / LB.G0, 1e-6, 'g');
  truthy('maglev tube is under 35 g at 8.8 km/s over 130 km', 8800 ** 2 / (2 * 130e3) / LB.G0 < 35);
}

// 10. Physical sanity on the default bench
{
  const ctx = LB.makeContext({ payload: { mass: 4000, gTol: 5 }, mission: { dest: 'LEO', alt: 400, lat: 28.5 } });
  const coil = LB.runMethod('coilgun', ctx, {}), spin = LB.runMethod('spin', ctx, {});
  truthy('crew-rated payload (5 g) cannot ride a 2 km coilgun', !coil.feasible);
  truthy('crew-rated payload (5 g) cannot ride a centrifugal sling', !spin.feasible);
  const air = LB.runMethod('airlaunch', LB.makeContext({ payload: { mass: 300, gTol: 10 }, mission: { dest: 'LEO', alt: 500, lat: 28.5 } }), {});
  const gnd = LB.runMethod('expendable', LB.makeContext({ payload: { mass: 300, gTol: 10 }, mission: { dest: 'LEO', alt: 500, lat: 28.5 } }), {});
  truthy('air launch needs less onboard Δv than a ground launch', air.dv.onboard < gnd.dv.onboard, `${air.dv.onboard.toFixed(0)} vs ${gnd.dv.onboard.toFixed(0)} m/s`);
}

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
