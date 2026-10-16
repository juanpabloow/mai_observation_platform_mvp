import { strict as assert } from 'node:assert';
import { test } from 'node:test';

/**
 * MF-1 item 2 — maintenance-service start-up smoke test.
 *
 * The `maintenance` Railway service (src/maintenanceMain.ts → startMeetingsMaintenance →
 * resolveMeetingsStorage → S3PrivateStore → `@aws-sdk/client-s3`) must be able to import its
 * storage chain. The audit worried that `@aws-sdk/client-s3`, declared in the root
 * package.json but missing from a *local* root node_modules, would crash this service at
 * runtime. It does not in production — the root package-lock.json carries the full
 * `@aws-sdk/client-s3` tree, so Railway's `npm ci` installs it — and this test fails loudly
 * (an un-resolvable import throws ERR_MODULE_NOT_FOUND at load) if that dependency ever goes
 * missing again, instead of surfacing only as a 2am purge-cycle crash.
 *
 * Importing these modules is side-effect-free: the purge clock starts only when
 * startMeetingsMaintenance() is CALLED, never on import — so this test never opens a socket,
 * touches the DB, or starts a timer.
 */
test('maintenance storage chain imports (proves @aws-sdk/client-s3 resolves)', async () => {
  const storage = await import('../../src/storage/s3PrivateStore.js');
  assert.equal(typeof storage.S3PrivateStore, 'function', 'S3PrivateStore class exported');
  assert.equal(typeof storage.evaluateConfirm, 'function');
  assert.equal(typeof storage.sha256Hex, 'function');

  const meetingsStorage = await import('../../src/storage/meetingsStorage.js');
  assert.equal(typeof meetingsStorage.resolveMeetingsStorage, 'function', 'storage resolver exported');

  const maintenance = await import('../../src/meetings/maintenance.js');
  assert.equal(typeof maintenance.startMeetingsMaintenance, 'function');
  assert.equal(typeof maintenance.stopMeetingsMaintenance, 'function');
  assert.equal(typeof maintenance.runPurgeCycle, 'function');
});
