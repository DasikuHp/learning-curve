// Seguridad de la API de salas: las acciones de un jugador piden el token que recibió al unirse,
// y por defecto la API no se abre a otras webs (sin Access-Control-Allow-Origin).
// Uso: node test/seguridad.spec.mjs http://localhost:8791
import { strict as assert } from 'node:assert';

const BASE = process.argv[2];
let fails = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (e) { console.log(`✘ ${name}: ${e.message}`); fails++; }
};
const post = async (p, body, headers = {}) => {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

if (!BASE) {
  console.log('Hace falta la URL del servidor: node test/seguridad.spec.mjs http://localhost:8791');
  process.exit(1);
}

const room = (await post('/api/rooms', { name: 'seguridad', soldiers: 1, seed: 1 })).body;
const yo = (await post(`/api/rooms/${room.code}/join`, { name: 'yo', team: 'left' })).body;
const otro = (await post(`/api/rooms/${room.code}/join`, { name: 'otro', team: 'right' })).body;

await check('join devuelve un token distinto para cada jugador', () => {
  assert.ok(yo.token && otro.token && yo.token !== otro.token);
});

await check('disparar sin token → 403', async () => {
  const r = await post(`/api/rooms/${room.code}/fire`, { playerId: yo.player.id, mode: 'function', expr: 'x' });
  assert.equal(r.status, 403, JSON.stringify(r.body));
});

await check('disparar con el token de otro jugador → 403', async () => {
  const r = await post(`/api/rooms/${room.code}/fire`, { playerId: yo.player.id, token: otro.token, mode: 'function', expr: 'x' });
  assert.equal(r.status, 403, JSON.stringify(r.body));
});

await check('moverse y escribir en el chat sin token → 403', async () => {
  assert.equal((await post(`/api/rooms/${room.code}/move`, { playerId: yo.player.id, stay: true })).status, 403);
  assert.equal((await post(`/api/rooms/${room.code}/chat`, { playerId: yo.player.id, text: 'hola' })).status, 403);
});

await check('empezar la partida en nombre de otro → 403', async () => {
  const r = await post(`/api/rooms/${room.code}/start`, { playerId: otro.player.id, token: yo.token });
  assert.equal(r.status, 403);
});

await check('con su propio token (en el cuerpo o en la cabecera X-Player-Token) sí se le atiende', async () => {
  const a = await post(`/api/rooms/${room.code}/chat`, { playerId: yo.player.id, token: yo.token, text: 'hola' });
  assert.notEqual(a.status, 403, JSON.stringify(a.body));
  const b = await post(`/api/rooms/${room.code}/chat`, { playerId: otro.player.id, text: 'hola' }, { 'X-Player-Token': otro.token });
  assert.notEqual(b.status, 403, JSON.stringify(b.body));
});

await check('un jugador que no existe → 404', async () => {
  assert.equal((await post(`/api/rooms/${room.code}/fire`, { playerId: 'nadie', token: 'x', expr: 'x' })).status, 404);
});

await check('CORS: por defecto no se permite llamar a la API desde otra web', async () => {
  const r = await fetch(BASE + '/api/health', { headers: { Origin: 'https://otra-web.example' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

console.log(fails ? `\nFAIL ✘ (${fails})` : '\nPASS ✔ (seguridad)');
process.exit(fails ? 1 : 0);
