// Prepara las redes de ejemplo de la demo pública: crea una red por plantilla, la entrena
// contra los bots y copia el resultado a demo/seed. Al arrancar con PUBLIC_DEMO=true y el
// laboratorio vacío, el servidor copia demo/seed a su carpeta de datos.
// Cada red entrena siempre contra el mismo bot, así su curva de victorias mide lo que aprende.
// Uso: node tools/demo-seed.mjs [partidas por red, 200 por defecto] [bot rival, greedy por defecto] [plantillas separadas por comas]
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GAMES = Number(process.argv[2] || 200);
const RIVAL = process.argv[3] || 'greedy';
const ONLY = process.argv[4] ? process.argv[4].split(',') : null;
const PORT = 8797;
const BASE = `http://localhost:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), 'gw-demo-seed-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${j.error || ''}`);
  return j;
};

const srv = spawn(process.execPath, ['server/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), GW_EVO_DIR: DATA }, stdio: 'ignore' });
try {
  for (let i = 0; i < 50; i++) { try { await api('/api/health'); break; } catch { await sleep(200); } }
  const templates = await api('/api/lab/templates');
  for (const t of templates.filter((x) => x.key !== 'empty' && (!ONLY || ONLY.includes(x.key)))) {
    const net = await api('/api/lab/nets', 'POST', { template: t.key, name: t.name.replace(/^\P{L}+/u, '') });
    const t0 = Date.now();
    const { id } = await api('/api/lab/trainings', 'POST', { netId: net.id, speed: 'turbo', duration: { games: GAMES }, opponents: { antagonist: 1, hallOfFame: 0, self: 0, antagonistId: RIVAL } });
    for (;;) {
      await sleep(2000);
      const cur = await api(`/api/lab/trainings/${id}`);
      if (cur && ['done', 'stopped', 'error'].includes(cur.status)) { console.log(`${t.key}: ${cur.status}, ${cur.games} partidas, ${Math.round((Date.now() - t0) / 1000)} s`); break; }
    }
  }
} finally {
  srv.kill();
  await sleep(500);
}
const OUT = join(ROOT, 'demo', 'seed');
if (existsSync(OUT)) rmSync(OUT, { recursive: true });
cpSync(DATA, OUT, { recursive: true });
console.log(`redes de ejemplo en ${OUT}`);
