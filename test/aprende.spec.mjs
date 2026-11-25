// La Vidente aprende de verdad: una red recién sacada de la plantilla entrena 150 partidas contra el bot
// chaos con las piezas del entrenador (makeLearner + playOne, lotes de la receta) y después se examina,
// congelada, en 40 partidas fijas contra el mismo bot, igual que la red sin entrenar.
// Se mide lo que el Simulador le pone delante: de los turnos en los que algún candidato mata,
// en cuántos escoge uno de esos. Sin entrenar escoge casi al azar entre 24.
process.env.GW_FAST = '1';
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GW_EVO_DIR = mkdtempSync(join(tmpdir(), 'gw-aprende-'));

let fails = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (e) { console.log(`✘ ${name}: ${e.message}`); fails++; }
};
const clone = (v) => JSON.parse(JSON.stringify(v));

const { TEMPLATES } = await import('../shared/templates.js');
const { makeRng } = await import('../shared/rng.js');
const { makeLearner, playOne } = await import('../evo/train.js');
const { playGame } = await import('../server/headless.js');

const RIVAL = { type: 'chaos', level: 3 };
const GAMES = 150, EXAM = 40;

function train(seed) {
  const g = { ...clone(TEMPLATES.seer.genome), id: `aprende-${seed}`, name: 'Aprende' };
  const L = makeLearner(g);
  const rng = makeRng(seed);
  const batchN = L.genome.learning.gradient.batchGames;
  const curve = [];
  let batch = [];
  for (let k = 0; k < GAMES; k++) {
    const me = { type: 'net', genome: L.genome, learn: true };
    const res = playOne({ seed: seed * 1000 + k, left: k % 2 ? RIVAL : me, right: k % 2 ? me : RIVAL, soldiers: 1 + rng.int(4) });
    batch.push({ events: res.events, trajectory: res.trajectories[res.playerId], playerId: res.playerId });
    curve.push(res.win);
    if (batch.length >= batchN) { L.learn(batch); batch = []; }
  }
  return { genome: clone(L.genome), curve };
}

function exam(genome) {
  const t = { wins: 0, chances: 0, picked: 0 };
  for (let i = 1; i <= EXAM; i++) {
    const r = playGame({ seed: 7000 + i, left: { type: 'net', genome }, right: RIVAL, soldiers: 2 });
    const me = r.room.players.find((p) => p.team === 'left').id;
    if (r.events.some((e) => e.type === 'win' && e.actor.playerId === me)) t.wins++;
    for (const steps of Object.values(r.trajectories[me].soldiers)) for (const s of steps) {
      const d = s.decision;
      if (s.phase !== 'shoot' || !d || !d.candidates || !d.candidates.some((c) => c.sim && c.sim.type === 'kill')) continue;
      t.chances++;
      if (d.candidates[d.chosen].sim.type === 'kill') t.picked++;
    }
  }
  return { winRate: t.wins / EXAM, pickRate: t.picked / Math.max(1, t.chances), chances: t.chances };
}

const pct = (x) => `${Math.round(100 * x)} %`;
const before = exam({ ...clone(TEMPLATES.seer.genome), id: 'aprende-sin', name: 'Sin entrenar' });
const t0 = Date.now();
const trained = train(11);
const after = exam(trained.genome);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
console.log(`sin entrenar: victorias ${pct(before.winRate)}, escoge el tiro que mata ${pct(before.pickRate)} (${before.chances} ocasiones)`);
console.log(`tras ${GAMES} partidas (${Math.round((Date.now() - t0) / 1000)} s): victorias ${pct(after.winRate)}, escoge el tiro que mata ${pct(after.pickRate)} (${after.chances} ocasiones)`);
console.log(`victorias durante el entreno: primeras 50 ${pct(mean(trained.curve.slice(0, 50)))}, últimas 50 ${pct(mean(trained.curve.slice(-50)))}`);

await check('la plantilla Vidente no lleva Ajustar y aprende con lr 0,01', () => {
  assert.ok(!TEMPLATES.seer.genome.blocks.some((b) => b.type === 'hand.adjust'));
  assert.ok(TEMPLATES.seer.genome.blocks.some((b) => b.type === 'eye.simulator'));
  assert.equal(trained.genome.learning.gradient.lr, 0.01);
});
await check('sin entrenar escoge el tiro que mata pocas veces (menos del 30 %)', () => {
  assert.ok(before.chances >= 30, `pocas ocasiones en el examen: ${before.chances}`);
  assert.ok(before.pickRate < 0.3, pct(before.pickRate));
});
await check('entrenada, escoge el tiro que mata al menos el 60 % de las veces y 30 puntos más que sin entrenar', () => {
  assert.ok(after.pickRate >= 0.6, pct(after.pickRate));
  assert.ok(after.pickRate - before.pickRate >= 0.3, `${pct(before.pickRate)} → ${pct(after.pickRate)}`);
});
await check('entrenada, gana al menos 20 puntos más que sin entrenar en las mismas partidas', () => {
  assert.ok(after.winRate - before.winRate >= 0.2, `${pct(before.winRate)} → ${pct(after.winRate)}`);
});
await check('durante el entreno gana más al final que al principio', () => {
  assert.ok(mean(trained.curve.slice(-50)) > mean(trained.curve.slice(0, 50)));
});
await check('determinista: el mismo entreno da la misma red', () => {
  const again = train(11);
  assert.deepEqual(again.curve, trained.curve);
  assert.deepEqual(again.genome.weights, trained.genome.weights);
});

console.log(fails ? `\nFAIL ✘ (${fails})` : '\nPASS ✔ (la Vidente aprende)');
process.exit(fails ? 1 : 0);
