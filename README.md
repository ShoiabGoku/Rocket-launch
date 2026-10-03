# LAUNCHBENCH

One payload, thirteen ways to space. LAUNCHBENCH takes a single test article (mass, survivable acceleration, packed density) and a destination, flies or solves every launch method from first principles, and ranks them on energy, cost, mass, readiness and emissions.

Open `index.html` through any static server (`node serve.js` → http://localhost:8801).

## Methods under test

| Family | Methods |
|---|---|
| Chemical rockets | Expendable two-stage (kerolox) · reusable booster (Falcon 9-style) · fully reusable methalox (Starship-style) |
| Assisted & beamed rockets | Air launch from a carrier jet · rockoon (balloon to 30 km) · laser-thermal SSTO (ground laser heats H₂) |
| Electromagnetic launchers | 2 km coilgun mass driver · 130 km maglev tube (StarTram Gen-1) · railgun |
| Gas guns & slings | Light-gas gun (Quicklaunch-type) · centrifugal sling (SpinLaunch-type) |
| Tethers & elevators | Rotating tether / rotovator skyhook (the orbital slingshot) · space elevator |

Beyond low orbit, the Jupiter mission can use Venus–Earth–Earth **gravity-assist slingshots**. These cut the departure C3 from 80 to 17 km²/s², at the cost of a trip of 6 years instead of 2.7.

## Watching each method fly

The **Trial runs** theatre plays every method's simulation in turn. Each run has three parts:

1. **The launcher at work.** You see a countdown on the pad, the carrier jet dropping its rocket, or the balloon ascent. Guns show the projectile racing up the coil track or maglev tunnel, the railgun's rails arcing, or the gas gun firing from its barge. The spin arm winds up and releases, the tether swings overhead, or the climber clamps onto the ribbon.
2. **The computed flight.** The vehicle flies its simulated trajectory with time compressed (the counter shows the warp). Live telemetry, a g-meter against the payload's limit, and a flight log of every event (staging, aeroshell jettison, catch, release, burns) update as it goes.
3. **The result.** A card shows mass, energy, cost, peak load and rank. Methods that cannot carry the payload stop partway through their launch sequence and show the reason.

It runs through all methods automatically, about 3½ minutes at 1×. Prev, Next, Pause and ½–4× speed let you control it, and you can click any method to watch that run. It pauses when scrolled out of view or when the tab is hidden.

## The physics (`engine.js`, no dependencies, runs in Node and the browser)

- **Trajectories**: 2-D point mass over a rotating spherical Earth, with RK4 integration, inverse-square gravity and the US Standard Atmosphere 1976 (tables to 1,000 km). Drag uses Mach-dependent C_D for rockets and for slender projectiles, and Isp varies with ambient pressure.
- **Guidance**: vertical rise, pitch kick and gravity turn. The upper stages then fly closed-loop guidance (a = 6Δr/t² − 4v_r/t, with time-to-go across all remaining stages) into a transfer ellipse, followed by an apoapsis trim. Air launch holds a fixed pull-up attitude, then hands over to guidance.
- **Sizing**: Tsiolkovsky with a structural fraction that worsens as stages shrink (fitted between Falcon 9 and Electron). The vehicle is resized against the losses it actually suffers, by secant steps and then bisection, until the flight closes. The Δv ledger closes: Δv_onboard = Δ|v| + gravity + drag + steering.
- **Guns, tubes and slings**: the launch load is v²/2L (×peak factor) or v²/r. The projectile coasts through the air, where its diameter follows its mass so the ballistic coefficient stays consistent. Heating follows Sutton–Graves, q̇ = 1.74×10⁻⁴·√(ρ/rₙ)·v³, and the ablator is sized from the drag work. A hardened onboard stage burns near apoapsis. Exit angle and speed are searched for the lightest projectile, and the drag deceleration at the muzzle must also stay inside the payload's g-limit.
- **Rotovator**: catches at v_cm − V_tip and releases at the swing angle that minimizes the kick. Tether mass follows the Hoyt/Moravec taper law, √π·x·e^(x²)·erf(x). Ballast keeps one catch from dropping the tip more than ~60 km. Reboost energy is Δp·v_cm/η, from solar power.
- **Space elevator**: climb energy is the rise in effective potential Φ = −μ/r − ½ω²r². The release radius is solved for each destination; low orbits need a release near 30,000 km and a 2 km/s perigee burn. Ribbon taper is exp(ρ·SF·ΔΦ/σ), with ribbon and counterweight masses integrated numerically.
- **Energy**: propellant combustion, grid electricity, carrier-aircraft fuel, solar reboost and propellant manufacture. Efficiency = payload orbital-energy gain ÷ total energy.
- **Cost**: TRANSCOST-style hardware law (∝ dry mass^0.6, calibrated to a ~$30M Falcon 9 first stage), propellant, power, operations, and infrastructure amortized over the campaign (extra facilities are built when the cadence exceeds one site's capacity).

## Validation

`node test/validate.js` runs 31 checks. All 31 pass:

- US-1976 densities at 0, 11, 20, 50, 80 and 400 km, and the speed of sound at sea level
- circular speed, geostationary radius, LEO→GEO Hohmann (3,893 m/s) and the 28.5° plane-change case, and TLI against vis-viva
- `sizeStage` reproduces the rocket equation exactly; RK4 conserves vacuum energy to < 1 ppb over 50 minutes
- elevator climb energy to GEO (48.4 MJ/kg) and free-escape altitude (46,745 km); tether mass ratio at V_tip = V_c (4.06)
- the ascent Δv ledger closes within 19 m/s; total Δv to a 400 km orbit from 28.5° is 9.35 km/s
- Falcon 9-class benchmark: sized for 22.8 t to LEO, the expendable kerolox vehicle comes out at 605 t gross (real: 549 t) and $2,266/kg
- crew-rated payloads (5 g) are correctly rejected by the coilgun and the spin sling; air launch needs less Δv than a ground launch

`node test/run.js [mass kg] [g-limit] [LEO|GEO|TLI|MARS|JUP] [alt km]` prints every method's result in the terminal.

## Limits

Flight is planar with an eastward azimuth, so GEO missions pay for the plane change. There is no aerodynamic lift, which penalises winged air launch. Gun heating uses a fixed heat fraction of the drag work. The rotovator catch and elevator ribbon need technology that has never been demonstrated, and their costs are published estimates uncertain by large factors.

## Files

- `engine.js`: physics, sizing, methods, scoring (UMD: `window.LB` or `require`)
- `app.js`, `style.css`, `index.html`: the interface (range canvas, leaderboard, SVG charts, crossover sweep, dossier)
- `theatre.js`: the trial-runs player (launcher scenes, time-warped flight playback, telemetry, result cards); `window.LBTheatre.step(seconds)` advances it deterministically for tests
- `test/validate.js`, `test/run.js`, `test/debug-*.js`: checks and probes
- `tools/build-artifact.js`: inlines everything into one page for publishing
- `serve.js`: local static server
