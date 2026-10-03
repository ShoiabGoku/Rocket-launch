// Quick bench: node test/run.js [mass] [gTol] [dest] [alt]
const LB = require('../engine.js');
const [mass = 200, gTol = 12000, dest = 'LEO', alt = 500, only] = process.argv.slice(2);
const ctx = LB.makeContext({ payload: { mass: +mass, gTol: +gTol }, mission: { dest, alt: +alt, lat: 28.5, assist: !!process.env.ASSIST }, fast: !!process.env.FAST });
const rows = [];
for (const M of LB.METHODS) {
  if (only && !only.split(',').includes(M.id)) continue;
  const t0 = Date.now();
  const R = LB.runMethod(M.id, ctx, {});
  const ms = Date.now() - t0;
  rows.push(R);
  const f = (v, d = 0) => (v == null || !isFinite(v) ? '-' : v.toFixed(d));
  console.log(
    M.id.padEnd(11), (R.feasible ? 'OK ' : 'NO ').padEnd(4),
    'M0', f(R.launchMass / 1000, 2).padStart(8), 't',
    ' eff', f(R.eff * 100, 2).padStart(6), '%',
    ' $/kg', f(R.costPerKg).padStart(9),
    ' MJ/kg', f(R.energyPerKg / 1e6).padStart(6),
    ' g', f(R.peakG, 1).padStart(7),
    ' dvOn', R.dv ? f(R.dv.onboard).padStart(6) : '     -',
    R.dv ? ` gl ${f(R.dv.gravity)} dl ${f(R.dv.drag)} sl ${f(R.dv.steering)} tr ${f(R.dv.trim)}` : '',
    ` ${ms}ms`,
    R.issues.map(i => i.level + ':' + i.text).join(' | ')
  );
  if (R.extra && R.extra.muzzle) console.log('            muzzle', R.extra.muzzle.toFixed(0), 'elev', R.extra.elev.toFixed(1), 'stages', R.extra.nStages, 'g', R.extra.gLaunch.toFixed(0), 'shell', R.extra.shell.toFixed(1), 'abl', R.extra.ablator.toFixed(2), 'diam', R.extra.diam && R.extra.diam.toFixed(2), 'heat MW/m2', (R.peakHeat / 1e6).toFixed(0));
  if (R.vehicle && R.vehicle.stages) console.log('            stages', R.vehicle.stages.map(s => `p${(s.prop).toFixed(0)} d${s.dry.toFixed(0)} e${(s.eps || 0).toFixed(3)}`).join(' / '), 'gp', R.gp);
}
const ranked = LB.score(rows, LB.DEFAULT_WEIGHTS);
console.log('\nRanking:', ranked.map(r => `${r.short || r.name}:${r.score.toFixed(0)}`).join(', '));
