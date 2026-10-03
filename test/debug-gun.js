// Fly one gun-launched projectile at a fixed exit state and print its trajectory.
// node test/debug-gun.js [v m/s] [elev deg] [exitAlt m] [dv onboard m/s] [stages]
const LB = require('../engine.js');
const [v = 7000, elev = 28, exitAlt = 4000, dv = 3000, n = 2] = process.argv.slice(2).map(Number);
const ctx = LB.makeContext({ payload: { mass: 200, gTol: 12000 }, mission: { dest: 'LEO', alt: 500, lat: 28.5 } });
const D = ctx.D;
const st1 = { prop: 'solid', law: 'upper', ispSL: 265, ispVac: 292, tw: 2.2, mul: 1.3 };
const st2 = { prop: 'storable', law: 'upper', ispSL: 290, ispVac: 318, tw: 1.6, mul: 1.3 };
const spec = { stages: n === 1 ? [st2] : [st1, st2], fairing: 0, pStart: 0, cdTab: LB.CD_SLENDER, aMax: 12000 * 9.8, shell: 60, shellArea: 0.4, rn: 0.04, diameter: () => 0.7 };
const veh = LB.buildVehicle(spec, 200, dv);
console.log('veh glow', veh.glow.toFixed(0), veh.stages.map(s => [s.prop.toFixed(0), s.dry.toFixed(0), s.mdot.toFixed(2)]));
const r0 = LB.RE + exitAlt, e = elev * Math.PI / 180;
const init = { x: r0, y: 0, vx: v * Math.sin(e), vy: ctx.omega * r0 + v * Math.cos(e), omega: ctx.omega, mode: 'coast' };
const sim = LB.fly(veh, init, D.tgt, 0, { record: true });
for (const p of sim.rec) if (p.ph !== 0 || p.t < 60 || Math.round(p.t) % 50 === 0) console.log(p.t.toFixed(1).padStart(7), 'alt', p.alt.toFixed(1).padStart(7), 'v', p.v.toFixed(0).padStart(5), 'ph', p.ph, 'g', p.g.toFixed(1), 'm', p.m.toFixed(0));
console.log(sim.events);
console.log({ ok: sim.ok, crashed: sim.crashed, exhausted: sim.exhausted, dvIdeal: sim.dvIdeal.toFixed(0), trim: sim.trim.toFixed(0), short: sim.shortfall.toFixed(0), left: sim.leftover.toFixed(0), need: sim.need.toFixed(0), avail: sim.avail.toFixed(0), losses: sim.losses, rp: ((sim.el.rp - LB.RE) / 1e3).toFixed(0), ra: ((sim.el.ra - LB.RE) / 1e3).toFixed(0) });
