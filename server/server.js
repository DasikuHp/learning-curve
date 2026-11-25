// Servidor HTTP: estáticos + API REST + SSE para clientes y agentes IA.
// Sin dependencias externas: Node >= 18.
import http from 'node:http';
import { readFileSync, existsSync, cpSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rooms, getRoom, createRoom } from './rooms.js';
import { listAgents } from '../agents/registry.js';
import { labApi, onExhibitionOver, initDemoSeeds } from '../evo/api.js';
import { useThreads } from '../evo/threads.js';
import { availableParallelism } from 'node:os';
import { worldsRoute, startWorlds } from './worlds.js';
import * as C from '../shared/constants.js';

// las partidas sin pantalla (duelos turbo, boletín, pre-torneo, entrenos turbo de 1 hilo) se juegan en hilos: el servidor
// solo coordina y aprende, y sigue contestando mientras tanto
// (en la demo pública, uno solo: el servidor gratuito tiene poca memoria)
useThreads(process.env.PUBLIC_DEMO === 'true' ? 1 : Math.max(2, Math.min(4, availableParallelism() - 1)));
// demo pública con el laboratorio vacío (el disco del servidor se borra en cada reinicio):
// se copian las redes de ejemplo que prepara tools/demo-seed.mjs
const SEED = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo', 'seed');
if (process.env.PUBLIC_DEMO === 'true' && process.env.GW_EVO_DIR && existsSync(SEED) && !existsSync(join(process.env.GW_EVO_DIR, 'nets'))) {
  cpSync(SEED, process.env.GW_EVO_DIR, { recursive: true });
}
// mundos (spec/09): lo de antes se archiva una vez (solo en la carpeta real) y se sigue en el último mundo abierto
startWorlds();
initDemoSeeds(); // en la demo pública, las redes que hay al arrancar son las de ejemplo

const PORT = Number(process.env.PORT) || 8787;
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT_DIR, 'public');
// módulos que el navegador comparte con el servidor (spec/08 §9.3): shared/*.js y la verdad; nada más
const SHARED_JS = /^\/shared\/[a-z0-9-]+\.js$/;
const EVO_JS = new Set(['/evo/truth.js', '/evo/voice.js']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json',
};
// Por defecto la API solo se llama desde la propia web (mismo origen) o desde programas como
// agent/agent.mjs, a los que CORS no afecta. Para dejar que otra web la use desde el navegador:
// CORS_ORIGIN=https://esa-web.example
const CORS = {
  ...(process.env.CORS_ORIGIN ? { 'Access-Control-Allow-Origin': process.env.CORS_ORIGIN } : {}),
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Player-Token',
};

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify(obj));
};
// pasado el tope deja de guardar y lee hasta el final sin guardar, para poder responder 413 (M10); más de 4× el tope, corta
const BODY_LIMIT = 1e5;
const OVER = Symbol('cuerpo demasiado grande');
const CUT = Symbol('cuerpo cortado'); // la conexión se cerró antes del final del cuerpo: la ruta no se ejecuta
// el tope es de bytes y el cuerpo se decodifica entero al final: una letra partida entre dos trozos llega intacta
// (spec/08 §10.6)
const readBody = (req) => new Promise((resolve) => {
  const parts = []; let bytes = 0, over = false, done = false;
  const finish = (complete) => {
    if (done) return;
    done = true;
    if (!complete) return resolve(CUT);
    if (over) return resolve(OVER);
    const d = Buffer.concat(parts).toString('utf8');
    try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); }
  };
  req.on('data', (c) => {
    bytes += c.length;
    if (over) { if (bytes > 4 * BODY_LIMIT) req.destroy(); return; }
    if (bytes > BODY_LIMIT) { over = true; parts.length = 0; return; }
    parts.push(c);
  });
  req.on('end', () => finish(true));
  req.on('close', () => finish(false));
});
const tooBig = (res) => json(res, 413, { error: `El cuerpo supera ${BODY_LIMIT} bytes.` });

// Las acciones de un jugador que se unió por la API (persona o agente externo) llevan el
// token que recibió en /join: sin él, cualquiera podría disparar o moverse en su nombre.
// Los bots juegan dentro del servidor y no tienen token.
function checkPlayer(room, pid, token) {
  const p = room.players.find((x) => x.id === pid);
  if (!p) return { status: 404, error: 'Jugador no encontrado en esta sala' };
  if (!p.isBot && p.token !== token) return { status: 403, error: 'Token no válido para este jugador' };
  return null;
}

const roomList = () => [...rooms.values()].map((r) => ({
  code: r.code, name: r.name, phase: r.phase,
  players: r.players.map((p) => ({ name: p.name, team: p.team, isBot: p.isBot })),
})).reverse();

async function api(req, res, parts, url) {
  const method = req.method;
  // /api/health
  if (parts[1] === 'health') return json(res, 200, { ok: true, rooms: rooms.size });
  if (parts[1] === 'agents') return json(res, 200, { agents: listAgents() });
  if (parts[1] === 'lab') return labApi(req, res, parts, url); // laboratorio (spec/08), cuerpos hasta 48 MB
  // en la demo pública nadie puede abrir ni borrar mundos: vaciaría el laboratorio a todos
  if (parts[1] === 'worlds' && PUBLIC_DEMO && method !== 'GET') {
    return json(res, 403, { error: 'En la demo los mundos no se pueden cambiar.' });
  }
  if (parts[1] === 'worlds') { // mundos (spec/09)
    const b = method === 'GET' ? {} : await readBody(req);
    if (b === CUT) return; // nadie espera la respuesta
    if (b === OVER) return tooBig(res);
    const r = worldsRoute(method, parts.slice(2), b);
    return json(res, r.status, r.body);
  }

  if (parts[1] !== 'rooms') return json(res, 404, { error: 'Ruta desconocida' });

  // /api/rooms
  if (!parts[2]) {
    if (method === 'GET') return json(res, 200, { rooms: roomList() });
    if (method === 'POST') {
      if (PUBLIC_DEMO && rooms.size >= DEMO_MAX_ROOMS) return json(res, 429, { error: 'La demo tiene demasiadas salas abiertas. Prueba en un momento.' });
      const b = await readBody(req);
      if (b === CUT) return; // nadie espera la respuesta
      if (b === OVER) return tooBig(res);
      const room = createRoom(b.name, { soldiersPerPlayer: b.soldiers, seed: b.seed, speed: b.speed });
      room.onGameOver = onExhibitionOver; // exhibición: cuenta, se guarda y, con learn:true, enseña (spec/04 §10.3)
      return json(res, 201, { code: room.code, name: room.name, soldiers: room.soldiersPerPlayer, seed: room.seed });
    }
    return json(res, 405, { error: 'Método no permitido' });
  }

  const room = getRoom(parts[2]);
  if (!room) return json(res, 404, { error: 'Sala no encontrada' });
  const sub = parts[3];

  if (!sub && method === 'GET') return json(res, 200, room.snapshot());
  if (sub === 'state' && method === 'GET') return json(res, 200, room.snapshot());

  if (sub === 'events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', ...CORS,
    });
    res.write('retry: 2000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify(room.snapshot())}\n\n`);
    room.listeners.add(res);
    req.on('close', () => room.listeners.delete(res));
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 20000);
    req.on('close', () => clearInterval(ping));
    return;
  }

  if (method !== 'POST') return json(res, 405, { error: 'Método no permitido' });
  const body = await readBody(req);
  if (body === CUT) return; // nadie espera la respuesta
  if (body === OVER) return tooBig(res);
  const pid = body.playerId;
  const token = body.token || req.headers['x-player-token'];
  if (['fire', 'move', 'chat'].includes(sub) || (sub === 'start' && pid)) {
    const denied = checkPlayer(room, pid, token);
    if (denied) return json(res, denied.status, { error: denied.error });
  }

  switch (sub) {
    case 'join': {
      const r = room.addPlayer(body.name, body.team);
      return r.error ? json(res, 400, r) : json(res, 200, { ...r, code: room.code });
    }
    case 'addbot': return json(res, 200, room.addBot(body.level ?? 2, body.type));
    case 'addagent': return json(res, 200, room.addAgent(body.type, body));
    case 'start': return json(res, 200, room.start(pid || body.playerId));
    case 'fire': return json(res, 200, room.fire(pid, body));
    case 'move': return json(res, 200, room.move(pid, body.stay ? 'stay' : { x: body.x, y: body.y }));
    case 'chat': return json(res, 200, room.addChat(pid, body.text));
    case 'rematch': return json(res, 200, room.rematch());
    default: return json(res, 404, { error: 'Endpoint desconocido' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (parts[0] === 'api') {
    try { await api(req, res, parts, url); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  if (SHARED_JS.test(url.pathname) || EVO_JS.has(url.pathname)) {
    const file = join(ROOT_DIR, url.pathname.slice(1));
    if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME['.js'] });
    return res.end(readFileSync(file));
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const path = normalize(join(PUBLIC_DIR, rel));
  if (!path.startsWith(PUBLIC_DIR) || !existsSync(path)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404');
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
  res.end(readFileSync(path));
});

// Demo pública: límites para un servidor gratuito (ver también DEMO_LIMITS en evo/api.js).
const PUBLIC_DEMO = process.env.PUBLIC_DEMO === 'true';
const DEMO_MAX_ROOMS = 20;

// Solo escucha en este equipo salvo que se pida otra cosa (HOST=0.0.0.0 en un servidor).
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`⚔️  Graphwar Agents en http://localhost:${PORT}`);
  console.log(`    API de agentes: ${C.MODES.FUNCTION ? 'POST /api/rooms/:code/fire' : ''}`);
});
