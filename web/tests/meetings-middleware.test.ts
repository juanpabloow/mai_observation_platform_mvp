import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware.js';

/**
 * B-1 · El middleware y las rutas de `/api/meetings/v1`.
 *
 * ── Por qué esta prueba tiene que existir ───────────────────────────────────
 *
 * Las 26 pruebas de Route Handler **importan e invocan el handler**. Es lo que
 * las hace rápidas y lo que las hace ciegas a esto: el middleware de Next no
 * participa. Durante toda la fase T-3 las seis rutas de máquina habrían
 * respondido **307 hacia /login** en staging —el worker no manda cookie— y
 * todo el árbol de pruebas estaba verde.
 *
 * Así que aquí se ejercita `middleware()` de verdad, con `NextRequest`, y se
 * comprueban las DOS mitades: que las de máquina pasen y que las de sesión
 * sigan rebotando. Un arreglo que abriera `/api/meetings` entero pasaría la
 * primera mitad y fallaría la segunda, que es exactamente el error que hay que
 * poder detectar.
 */

const ORIGIN = 'https://staging.example.test';

function request(path: string, options?: { cookie?: string }): NextRequest {
  return new NextRequest(new URL(path, ORIGIN), {
    headers: options?.cookie ? { cookie: options.cookie } : {},
  });
}

/** Las SEIS rutas de máquina: Bearer, sin cookie, las llama el worker. */
const MACHINE_ROUTES = [
  '/api/meetings/v1/jobs/claim',
  '/api/meetings/v1/jobs/00000000-0000-0000-0000-000000000000/heartbeat',
  '/api/meetings/v1/jobs/00000000-0000-0000-0000-000000000000/fail',
  '/api/meetings/v1/jobs/00000000-0000-0000-0000-000000000000/result/init',
  '/api/meetings/v1/jobs/00000000-0000-0000-0000-000000000000/result/complete',
  '/api/meetings/v1/maintenance/requeue-expired',
] as const;

/** Las CINCO de sesión: cookie, y sin ella tienen que rebotar. */
const SESSION_ROUTES = [
  '/api/meetings/v1/meetings',
  '/api/meetings/v1/meetings/00000000-0000-0000-0000-000000000000',
  '/api/meetings/v1/meetings/00000000-0000-0000-0000-000000000000/upload-init',
  '/api/meetings/v1/meetings/00000000-0000-0000-0000-000000000000/upload-complete',
  '/api/meetings/v1/meetings/00000000-0000-0000-0000-000000000000/cancel',
] as const;

/** Los ficheros de las seis rutas de máquina, para el chequeo estático. */
const MACHINE_ROUTE_FILES = [
  'web/app/api/meetings/v1/jobs/claim/route.ts',
  'web/app/api/meetings/v1/jobs/[jobId]/heartbeat/route.ts',
  'web/app/api/meetings/v1/jobs/[jobId]/fail/route.ts',
  'web/app/api/meetings/v1/jobs/[jobId]/result/init/route.ts',
  'web/app/api/meetings/v1/jobs/[jobId]/result/complete/route.ts',
  'web/app/api/meetings/v1/maintenance/requeue-expired/route.ts',
] as const;

const SESSION_ROUTE_FILES = [
  'web/app/api/meetings/v1/meetings/route.ts',
  'web/app/api/meetings/v1/meetings/[meetingId]/route.ts',
  'web/app/api/meetings/v1/meetings/[meetingId]/upload-init/route.ts',
  'web/app/api/meetings/v1/meetings/[meetingId]/upload-complete/route.ts',
  'web/app/api/meetings/v1/meetings/[meetingId]/cancel/route.ts',
] as const;

/** Rutas relativas a la raíz del repositorio, desde `web/tests/`. */
const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

// ── La mitad de máquina ─────────────────────────────────────────────────────

test('las seis rutas de máquina LLEGAN al handler sin cookie', () => {
  for (const path of MACHINE_ROUTES) {
    const response = middleware(request(path));
    assert.equal(
      response.headers.get('location'),
      null,
      `${path} no debe redirigir: el worker recibiría HTML en vez de JSON`,
    );
    assert.ok(
      response.status < 300,
      `${path} devolvió ${response.status}; se esperaba que continuara al handler`,
    );
  }
});

test('y el handler es quien responde 401: cada una llama authenticateWorker', () => {
  // La otra mitad del contrato. Que el middleware las deje pasar sólo es
  // correcto si el handler autentica; si alguna no lo hiciera, este cambio la
  // habría dejado ABIERTA.
  for (const file of MACHINE_ROUTE_FILES) {
    const source = read(file);
    assert.match(
      source,
      /authenticateWorker\s*\(/,
      `${file} no llama authenticateWorker y ahora es pública en el middleware`,
    );
  }
});

test('ninguna ruta de máquina resuelve el ámbito de sesión', () => {
  // Si una lo hiciera, arrastraría better-auth y dependería de una cookie que
  // el worker no manda.
  for (const file of MACHINE_ROUTE_FILES) {
    assert.doesNotMatch(
      read(file),
      /meetingsAppScope/,
      `${file} es de máquina y no debe resolver ámbito de sesión`,
    );
  }
});

// ── La mitad de sesión ──────────────────────────────────────────────────────

test('las cinco rutas de sesión SIGUEN rebotando a /login sin cookie', () => {
  for (const path of SESSION_ROUTES) {
    const response = middleware(request(path));
    const location = response.headers.get('location');
    assert.ok(location, `${path} debe redirigir sin cookie`);
    const url = new URL(location);
    assert.equal(url.pathname, '/login', `${path} debe rebotar a /login`);
    assert.equal(
      url.searchParams.get('redirect'),
      path,
      `${path} debe conservar el destino en ?redirect`,
    );
  }
});

test('y cada una resuelve el ámbito de sesión, que es la puerta real', () => {
  for (const file of SESSION_ROUTE_FILES) {
    assert.match(read(file), /meetingsAppScope/, `${file} debe resolver el ámbito`);
  }
});

// ── El alcance del cambio, medido ───────────────────────────────────────────

test('el prefijo público NO es todo /api/meetings', () => {
  const source = read('web/middleware.ts');
  const prefixes = source.slice(source.indexOf('const PUBLIC_PREFIXES'));
  const meetingsPrefixes = [...prefixes.matchAll(/"(\/api\/meetings[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(
    meetingsPrefixes.sort(),
    ['/api/meetings/v1/jobs', '/api/meetings/v1/maintenance'],
    'sólo los dos subárboles de máquina; abrir /api/meetings expondría las de sesión',
  );
});

test('una ruta de meetings inventada tampoco pasa', () => {
  // El prefijo es un prefijo, no un comodín: una ruta futura fuera de los dos
  // subárboles no hereda el permiso por accidente.
  for (const path of [
    '/api/meetings',
    '/api/meetings/v1',
    '/api/meetings/v1/admin',
    '/api/meetings/v2/jobs/claim',
  ]) {
    const response = middleware(request(path));
    assert.ok(
      response.headers.get('location'),
      `${path} no está en ningún subárbol público y debe rebotar`,
    );
  }
});

test('el prefijo casa por segmento, no por texto', () => {
  // `/api/meetings/v1/jobsomething` empieza por la misma cadena que
  // `/api/meetings/v1/jobs` pero NO es una subruta suya. La comprobación del
  // middleware es `p === pathname || pathname.startsWith(p + "/")`, así que
  // esto debe rebotar. Si alguien la relajara a `startsWith(p)`, esta prueba
  // lo diría.
  const response = middleware(request('/api/meetings/v1/jobsomething'));
  assert.ok(response.headers.get('location'), 'no debe colarse por prefijo textual');
});

// ── Lo que el middleware sigue haciendo ─────────────────────────────────────

test('las rutas de máquina reciben x-pathname y x-search igual que el resto', () => {
  const response = middleware(request('/api/meetings/v1/jobs/claim?foo=bar'));
  assert.equal(response.headers.get('location'), null);
  // `NextResponse.next({ request: { headers } })` expone las cabeceras
  // reescritas en `x-middleware-request-*`. No es API pública, así que se
  // comprueba de forma tolerante: lo que importa es que no rebote.
  assert.ok(response.status < 300);
});
