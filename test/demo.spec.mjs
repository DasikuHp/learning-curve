// Demo pública (PUBLIC_DEMO=true): se puede crear y entrenar redes propias, pero con límites,
// y las redes de ejemplo (las que había al arrancar) no se pueden cambiar, entrenar ni borrar.
// Arranca sus propios servidores en otro puerto. Uso: node test/demo.spec.mjs
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DEMO_TEST_PORT || 8798);
const BASE = `http://localhost:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), 'gw-demo-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (e) { console.log(`✘ ${name}: ${e.message}`); fails++; }
};
const call = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const boot = async (demo) => {
  const env = { ...process.env, PORT: String(PORT), GW_EVO_DIR: DATA, GW_FAST: '1', PUBLIC_DEMO: demo ? 'true' : '' };
  const srv = spawn(process.execPath, ['server/server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { await call('/api/health'); return srv; } catch { await sleep(100); } }
  throw new Error('el servidor no arranca');
};
const stop = async (srv) => { srv.kill(); await new Promise((r) => srv.once('exit', r)); };
const train = (netId, extra = {}) => call('/api/lab/trainings', 'POST', { netId, speed: 'turbo', duration: { games: 300 }, ...extra });

// 1) sin demo: una red que hará de red de ejemplo
let srv = await boot(false);
const seed = (await call('/api/lab/nets', 'POST', { template: 'sniper', name: 'Ejemplo' })).body.id;
await stop(srv);

// 2) la misma carpeta, en modo demo
srv = await boot(true);
let mine = null, third = null;
try {
  await check('la red de ejemplo no se puede borrar, editar ni cambiar sus pesos', async () => {
    assert.equal((await call(`/api/lab/nets/${seed}`, 'DELETE')).status, 403);
    const g = (await call(`/api/lab/nets/${seed}`)).body;
    assert.equal((await call(`/api/lab/nets/${seed}`, 'PUT', g.genome || g)).status, 403);
    assert.equal((await call(`/api/lab/nets/${seed}/frozen`, 'PUT', { blocks: [] })).status, 403);
  });

  await check('la red de ejemplo no se entrena', async () => {
    assert.equal((await train(seed)).status, 403);
  });

  await check('se puede crear una red propia desde una plantilla', async () => {
    const r = await call('/api/lab/nets', 'POST', { template: 'sniper', name: 'Mía' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    mine = r.body.id;
  });

  await check('un entreno demasiado largo o hasta meseta se rechaza', async () => {
    assert.equal((await train(mine, { duration: { games: 5000 } })).status, 400);
    assert.equal((await train(mine, { duration: { minutes: 60 } })).status, 400);
    assert.equal((await train(mine, { duration: { plateau: { window: 10, minGain: 0 } } })).status, 400);
  });

  await check('como mucho dos entrenos a la vez; el tercero recibe 429', async () => {
    const other = (await call('/api/lab/nets', 'POST', { template: 'turtle', name: 'Otra' })).body.id;
    third = (await call('/api/lab/nets', 'POST', { template: 'seer', name: 'Tercera' })).body.id;
    const a = await train(mine);
    const b = await train(other);
    assert.equal(a.status, 202, JSON.stringify(a.body));
    assert.equal(b.status, 202, JSON.stringify(b.body));
    const c = await train(third);
    assert.equal(c.status, 429, JSON.stringify(c.body));
    for (const t of [a, b]) await call(`/api/lab/trainings/${t.body.id}/stop`, 'POST', {});
  });

  await check('los mundos no se pueden abrir ni borrar', async () => {
    assert.equal((await call('/api/worlds/2/new', 'POST', {})).status, 403);
    assert.equal((await call('/api/worlds')).status, 200, 'mirarlos sí');
  });

  await check('las redes propias sí se pueden borrar', async () => {
    const r = await call(`/api/lab/nets/${third}`, 'DELETE');
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
} finally {
  await stop(srv);
}

console.log(fails ? `\nFAIL ✘ (${fails})` : '\nPASS ✔ (demo pública)');
process.exit(fails ? 1 : 0);
