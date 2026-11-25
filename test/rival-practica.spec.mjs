// Rival por defecto del entreno: sin reina ni rival fijo, POST /api/lab/trainings pone de antagonista la rival de
// práctica del mundo (Vidente 1), así un mundo nuevo no entrena solo contra copias de sí misma. Con rival fijo, con
// reina o si la red es la propia rival de práctica, no cambia nada. Por la API con servidor propio.
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (e) { console.log(`✘ ${name}: ${e.message}`); fails++; }
};

const base = mkdtempSync(join(tmpdir(), 'gw-rival-'));
const port = 30000 + ((process.pid + 7500) % 10000);
const url = `http://localhost:${port}`;
const srv = spawn(process.execPath, [join(ROOT, 'server', 'server.js')], { env: { ...process.env, GW_FAST: '1', PORT: String(port), GW_EVO_DIR: base }, stdio: 'ignore' });
const api = async (p, method = 'GET', body) => {
  const r = await fetch(url + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const train = async (netId, opponents) => {
  const body = { netId, speed: 'turbo', duration: { games: 4 }, soldiers: 1 };
  if (opponents) body.opponents = opponents;
  const r = await api('/api/lab/trainings', 'POST', body);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  for (let i = 0; i < 600; i++) {
    const t = (await api(`/api/lab/trainings/${r.body.id}`)).body;
    if (['done', 'stopped', 'error'].includes(t.status)) { assert.equal(t.status, 'done', t.error); return t; }
    await sleep(100);
  }
  throw new Error('el entreno no acaba');
};
const kinds = (t) => [...new Set(t.curve.map((p) => p.rival))].sort();

try {
  const t0 = Date.now();
  for (;;) { try { if ((await fetch(url + '/api/health')).ok) break; } catch { /* aún no */ } if (Date.now() - t0 > 20000) throw new Error('el servidor no arranca'); await sleep(100); }
  assert.equal((await api('/api/worlds/1/new', 'POST', { path: 'cero' })).status, 201);
  assert.equal((await api('/api/worlds/1/open', 'POST', {})).status, 200);
  const a = (await api('/api/lab/nets', 'POST', { template: 'seer', name: 'Alumna' })).body.id;

  await check('sin reina ni rival fijo: el antagonista es Vidente 1, la rival de práctica', async () => {
    const t = await train(a, { antagonist: 1, hallOfFame: 0, self: 0 });
    assert.equal(t.config.opponents.antagonistId, 'vidente-1');
    assert.deepEqual(kinds(t), ['antagonist']);
  });
  await check('la receta por defecto también: sin reina juega contra Vidente 1 y no solo contra sí misma', async () => {
    const t = await train(a);
    assert.equal(t.config.opponents.antagonistId, 'vidente-1');
  });
  await check('con rival fijo, se queda el que se eligió', async () => {
    const t = await train(a, { antagonist: 1, hallOfFame: 0, self: 0, antagonistId: 'chaos' });
    assert.equal(t.config.opponents.antagonistId, 'chaos');
  });
  await check('Vidente 1 no entrena contra sí misma: sin rival, cae a su propia copia como antes', async () => {
    const t = await train('vidente-1', { antagonist: 1, hallOfFame: 0, self: 0 });
    assert.ok(!t.config.opponents.antagonistId, JSON.stringify(t.config.opponents));
    assert.deepEqual(kinds(t), ['self']);
  });
  await check('con reina, no se toca: el antagonista sigue siendo la reina', async () => {
    const r = await api('/api/lab/throne/challenge', 'POST', { challenger: a });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = (await api('/api/lab/nets', 'POST', { template: 'seer', name: 'Otra' })).body.id;
    const t = await train(b, { antagonist: 1, hallOfFame: 0, self: 0 });
    assert.ok(!t.config.opponents.antagonistId, JSON.stringify(t.config.opponents));
    assert.deepEqual(kinds(t), ['antagonist']);
  });
} catch (e) {
  console.log(`✘ preparación: ${e.message}`); fails++;
} finally {
  srv.kill();
}

console.log(fails ? `\nFAIL ✘ (${fails})` : '\nPASS ✔ (rival de práctica por defecto)');
process.exit(fails ? 1 : 0);
