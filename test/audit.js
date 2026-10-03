// Energy-audit closure check for every method: node test/audit.js [mass] [g] [dest]
const LB = require('../engine.js');
const [mass = 200, g = 12000, dest = 'LEO'] = process.argv.slice(2);
const ctx = LB.makeContext({ payload: { mass: +mass, gTol: +g }, mission: { dest, alt: 500, lat: 28.5 } });
const pct = v => (v * 100).toFixed(1).padStart(5);
console.log('method       η_util η_conv η_prop η_aero η_pay | η_overall  closure  | E_in MJ/kg');
for (const M of LB.METHODS) {
  const R = LB.runMethod(M.id, ctx, {});
  if (!R.feasible) { console.log(M.id.padEnd(12), 'not viable'); continue; }
  const c = R.cascade, e = c.eta;
  console.log(M.id.padEnd(12), pct(e.utilisation), pct(e.conversion), pct(e.propulsive), pct(e.aero), pct(e.payload), '|', pct(e.overall), '  ', (c.closure * 100).toFixed(2).padStart(6), '% |', (c.Ein / +mass / 1e6).toFixed(0), c.sources.map(s => s.k + ':' + (s.J / c.Ein * 100).toFixed(0)).join(' '));
}
