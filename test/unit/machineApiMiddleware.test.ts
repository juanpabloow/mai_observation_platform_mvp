import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { NextRequest } from '../../web/node_modules/next/server.js';
import { middleware } from '../../web/middleware.js';

/**
 * The MACHINE APIs are cookieless Bearer-token routes (n8n, the GPU worker). The
 * middleware is only an optimistic UX bounce, but if a machine prefix is missing from
 * PUBLIC_PREFIXES every call gets a 307 to /login instead of reaching the route — and
 * route tests never see it because they import the handler directly. This has happened
 * twice: /api/meetings/v1/jobs, and /api/catalog/v1 (shipped in f7c4cf7; production
 * answered a cookieless GET with `307 location: /login?redirect=/api/catalog/v1/products`).
 */
const ORIGIN = 'http://mai.test';
const run = (path: string, headers: Record<string, string> = {}) =>
  middleware(new NextRequest(`${ORIGIN}${path}`, { headers }));
const isBounce = (res: Response) => res.status === 307 && (res.headers.get('location') ?? '').includes('/login');

const BEARER = { authorization: 'Bearer test-token-not-real' };

test('every machine API reaches its route without a session cookie', () => {
  for (const path of [
    '/api/handoff/v1/messages',
    '/api/handoff/v1/context',
    '/api/scheduling/v1/availability',
    '/api/crm/v1/contacts/upsert',
    '/api/catalog/v1/products',
    '/api/meetings/v1/jobs/claim',
    '/api/meetings/v1/maintenance/sweep',
    '/api/booking/v1/sites',
    '/api/health',
  ]) {
    const res = run(path, BEARER);
    assert.equal(isBounce(res), false, `${path} must not bounce a Bearer caller to /login`);
  }
});

test('session-only surfaces still bounce to /login without a cookie', () => {
  for (const path of [
    '/clients/00000000-0000-0000-0000-000000000000/contacts',
    '/api/meetings/v1/meetings/abc',
    '/api/catalogue-not-a-prefix',
    '/api/catalog-v2/products',
  ]) {
    const res = run(path, BEARER);
    assert.equal(isBounce(res), true, `${path} keeps the login bounce`);
  }
});
