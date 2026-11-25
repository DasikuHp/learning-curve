// Demo pública (PUBLIC_DEMO=true): se juega como en local (mundos, redes, entrenos), pero con
// límites para un servidor gratuito: entrenos cortos y como mucho dos trabajos pesados a la vez.
// Arranca su propio servidor en otro puerto. Uso: node test/demo.spec.mjs
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
const train = (netId, extra = {}) => call('/api/lab/trainings', 'POST', { netId, speed: 'turbo', duration: { games: 300 }, ...extra });

const env = { ...process.env, PORT: String(PORT), GW_EVO_DIR: DATA, GW_FAST: '1', PUBLIC_DEMO: 'true' };
const srv = spawn(process.execPath, ['server/server.js'], { cwd: ROOT, env, stdio: 'ignore' });
let ready = false;
for (let i = 0; i < 100 && !ready; i++) { try { await call('/api/health'); ready = true; } catch { await sleep(100); } }

const nets = [];
try {
  await check('el servidor de la demo arranca', () => assert.ok(ready));

  await check('se puede crear y abrir un mundo, que trae la red base', async () => {
    const w = await call('/api/worlds/1/new', 'POST', { path: 'cero', name: 'Demo' });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    const o = await call('/api/worlds/1/open', 'POST', {});
    assert.equal(o.status, 200, JSON.stringify(o.body));
    const list = (await call('/api/lab/nets')).body.nets.map((n) => n.id);
    assert.ok(list.includes('vidente-1'), list.join(','));
  });

  await check('se pueden crear redes desde una plantilla', async () => {
    for (const template of ['sniper', 'turtle', 'seer']) {
      const r = await call('/api/lab/nets', 'POST', { template, name: `Mía ${template}` });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      nets.push(r.body.id);
    }
  });

  await check('un entreno demasiado largo o hasta meseta se rechaza', async () => {
    assert.equal((await train(nets[0], { duration: { games: 5000 } })).status, 400);
    assert.equal((await train(nets[0], { duration: { minutes: 60 } })).status, 400);
    assert.equal((await train(nets[0], { duration: { plateau: { window: 10, minGain: 0 } } })).status, 400);
  });

  await check('como mucho dos entrenos a la vez; el tercero recibe 429', async () => {
    const a = await train(nets[0]);
    const b = await train(nets[1]);
    assert.equal(a.status, 202, JSON.stringify(a.body));
    assert.equal(b.status, 202, JSON.stringify(b.body));
    const c = await train(nets[2]);
    assert.equal(c.status, 429, JSON.stringify(c.body));
    for (const t of [a, b]) await call(`/api/lab/trainings/${t.body.id}/stop`, 'POST', {});
  });

  await check('una red que no entrena se puede borrar', async () => {
    const r = await call(`/api/lab/nets/${nets[2]}`, 'DELETE');
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
} finally {
  srv.kill();
  await new Promise((r) => srv.once('exit', r));
}

console.log(fails ? `\nFAIL ✘ (${fails})` : '\nPASS ✔ (demo pública)');
process.exit(fails ? 1 : 0);
