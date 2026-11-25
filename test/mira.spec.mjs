// Ojo 🔭 Mira: para cada candidato, la cercanía nítida de su curva a cada enemigo, exp(−(e/0,7)²), con e = diferencia de
// altura en la x del enemigo (0,7 = radio de impacto). 0 si es una EDO, si no se puede evaluar o si falta el enemigo.
// Escrito con la escena de percepcion.spec y valores calculados a mano.
import { strict as assert } from 'node:assert';

let fails = 0;
const check = (name, fn) => {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { console.log(`✘ ${name}: ${e.message}`); fails++; }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const C = await import('../shared/constants.js');
const { makeRng } = await import('../shared/rng.js');
const { tryCompile } = await import('../shared/parser.js');
const { repair, outDims, BLOCKS, validate } = await import('../shared/genome.js');
const { compile } = await import('../shared/nn.js');
const P = await import('../shared/percept.js');
const lib = await import('../agents/lib.js');

function scene({ team = 'left' } = {}) {
  const m = team === 'left' ? 1 : -1;
  const mk = (id, ownerId, t, x, y, alive = true) => ({ id, ownerId, team: t, x: x * m, y, alive, lastExpr: '', turns: 0 });
  const other = team === 'left' ? 'right' : 'left';
  const soldiers = [mk('me', 'p1', team, -10, 2), mk('a1', 'p1', team, -12, 3), mk('e1', 'p2', other, 5, 4), mk('e2', 'p2', other, 12, -6)];
  const obstacles = [{ x: -2, y: 0, w: 2, h: 5 }].map((o) => (m === 1 ? o : { x: -(o.x + o.w), y: o.y, w: o.w, h: o.h }));
  const players = [{ id: 'p1', name: 'Yo', team, isBot: true, kills: 0, deaths: 0, alive: 2 }, { id: 'p2', name: 'Rival', team: other, isBot: true, kills: 0, deaths: 0, alive: 2 }];
  return { code: 'T', phase: 'playing', soldiers, obstacles, players, shotLog: [], stats: { shots: 0, shotsNoKill: 0, remaps: 0 }, history: [], chat: [], config: { plane: C.PLANE } };
}
const ctxOf = (st, id = 'me') => { const s = st.soldiers.find((x) => x.id === id); return { ...lib.contextFor(st.soldiers, st.obstacles, s), team: s.team }; };
const closeness = (f, me, e) => Math.exp(-(((f(e.x) - f(me.x) + me.y - e.y) / C.HIT_RADIUS) ** 2));

check('el bloque Mira: ojo de aprendiz, sin entradas, da la corriente de candidatos con 2 números por candidato', () => {
  const b = BLOCKS['eye.aim'];
  assert.ok(b && b.name === 'Mira' && b.group === 'eyes' && b.level === 'aprendiz' && b.explain && b.example && b.icon);
  assert.deepEqual(b.streams, { in: [], out: 'cand' });
  assert.deepEqual(P.eyeLayout({ id: 'mi', type: 'eye.aim', params: {} }).map((x) => x.name), ['cercanía al enemigo 1', 'cercanía al enemigo 2']);
});

check('aimFeatures: recta exacta al enemigo 1 → ≈ 1; al enemigo 2, exp(−(e/0,7)²) con su diferencia de altura', () => {
  const st = scene(); const me = st.soldiers[0]; const ctx = ctxOf(st);
  const e = st.soldiers.filter((s) => s.team === 'right').sort((a, b) => dist(a, me) - dist(b, me));
  const s0 = (e[0].y - me.y) / (e[0].x - me.x);
  const line = { i: 0, family: 'line', params: [s0, 0, 0], mode: 'function', exprLocal: `${s0.toFixed(5)}*x`, expr: `${s0.toFixed(5)}*x`, angle: null };
  const f = tryCompile(line.exprLocal).f;
  const got = P.aimFeatures(line, ctx);
  assert.equal(got.length, 2);
  assert.ok(near(got[0], closeness(f, me, e[0])) && got[0] > 0.999, `enemigo 1: ${got[0]}`);
  assert.ok(near(got[1], closeness(f, me, e[1])), `enemigo 2: ${got[1]}`);
  assert.ok(got[1] < 1e-6, 'el enemigo 2 queda lejísimos de esa recta');
});

check('aimFeatures: a 0,35 u por encima vale exp(−0,25) ≈ 0,78; a 1 u, ≈ 0,13; a 2 u, casi 0', () => {
  const st = scene(); const me = st.soldiers[0]; const ctx = ctxOf(st);
  const e1 = st.soldiers.find((s) => s.id === 'e1');
  for (const [d, exp] of [[0.35, Math.exp(-0.25)], [1, Math.exp(-((1 / 0.7) ** 2))], [2, Math.exp(-((2 / 0.7) ** 2))]]) {
    const s = (e1.y + d - me.y) / (e1.x - me.x);
    const line = { i: 0, family: 'line', params: [s, 0, 0], mode: 'function', exprLocal: `${s}*x`, expr: `${s}*x`, angle: null };
    assert.ok(near(P.aimFeatures(line, ctx)[0], exp, 1e-9), `${d} u: ${P.aimFeatures(line, ctx)[0]} ≠ ${exp}`);
  }
});

check('aimFeatures: EDO y artillería → 0; expresión que no compila → 0; sin segundo enemigo vivo → 0', () => {
  const st = scene(); const ctx = ctxOf(st);
  const ode = { i: 4, family: 'ode1', params: [1, 6, 0], mode: 'ode1', exprLocal: '1.000*sin(x/6.000)+0.000', expr: '1.000*sin(x/6.000)+0.000', angle: null };
  assert.deepEqual(Array.from(P.aimFeatures(ode, ctx)), [0, 0]);
  const art = { i: 1, family: 'artillery', params: [0.07, 40, 0], mode: 'ode2', exprLocal: '-0.0700', expr: '-0.0700', angle: 40 };
  assert.deepEqual(Array.from(P.aimFeatures(art, ctx)), [0, 0]);
  const bad = { i: 5, family: 'wild', params: [0, 0, 0], mode: 'function', exprLocal: 'x+(', expr: 'x+(', angle: null };
  assert.deepEqual(Array.from(P.aimFeatures(bad, ctx)), [0, 0]);
  const one = scene(); one.soldiers.find((s) => s.id === 'e2').alive = false;
  const line = { i: 0, family: 'line', params: [0.1, 0, 0], mode: 'function', exprLocal: '0.1*x', expr: '0.1*x', angle: null };
  assert.equal(P.aimFeatures(line, ctxOf(one))[1], 0);
});

check('aimFeatures: el equipo derecho ve lo mismo en su marco local (espejo)', () => {
  const L = scene(); const R = scene({ team: 'right' });
  const line = { i: 0, family: 'line', params: [0.12, 0, 0], mode: 'function', exprLocal: '0.12*x', expr: '0.12*x', angle: null };
  const a = P.aimFeatures(line, ctxOf(L)), b = P.aimFeatures(line, ctxOf(R));
  assert.ok(near(a[0], b[0]) && near(a[1], b[1]), `${Array.from(a)} vs ${Array.from(b)}`);
});

check('en una red: Mira → Elegir es válida, compila y la observación trae 2 números por candidato', () => {
  const g = repair({ format: 1, id: 'mira-sola', name: 'Mira sola', blocks: [{ id: 'mi', type: 'eye.aim', params: {} }, { id: 'ch', type: 'hand.choose', params: {} }], wires: [{ from: 'mi', to: 'ch' }] }, makeRng(1)).genome;
  assert.equal(validate(g).errors.length, 0, JSON.stringify(validate(g).errors));
  assert.deepEqual(outDims(g).mi, { stream: 'cand', dim: 2 });
  const st = scene();
  const obs = P.observeNormalized(st, 'me', g, { phase: 'shoot' });
  assert.ok(obs.candidates && obs.candidates.length === obs.cand.mi.length && obs.cand.mi.every((r) => r.length === 2));
  obs.candidates.forEach((c, i) => assert.deepEqual(Array.from(obs.cand.mi[i]), Array.from(P.aimFeatures(c, ctxOf(st)))));
  const out = compile(g).forward(obs, compile(g).zeroState());
  assert.equal(out.outputs.choose.scores.length, obs.candidates.length);
});

console.log(fails ? `\nFAIL ✘ (${fails})` : '\nPASS ✔ (ojo Mira)');
process.exit(fails ? 1 : 0);
