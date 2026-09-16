import { strict as assert } from 'node:assert';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { HASH_CHUNK_BYTES, Sha256, sha256HexOfBlob } from '../../web/lib/sha256.js';

/**
 * El SHA-256 del navegador, contra los vectores publicados y contra una
 * implementación independiente.
 *
 * Un hash escrito a mano que falla sólo para ciertos tamaños es la peor clase
 * de defecto aquí: la subida se completaría, `upload-complete` compararía el
 * checksum declarado con el que R2 midió y devolvería `checksum_mismatch`, y el
 * usuario vería «el fichero llegó corrupto» sobre un fichero intacto. Así que
 * se prueba en los bordes que esas implementaciones equivocan: el bloque de 64
 * bytes, y los tamaños donde los ocho bytes de longitud no caben en el último
 * bloque (55, 56, 63, 64).
 */

const hex = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

const feed = (data: Uint8Array, chunk: number): string => {
  const h = new Sha256();
  for (let i = 0; i < data.length; i += chunk) h.update(data.subarray(i, i + chunk));
  return h.digestHex();
};

test('los vectores del NIST', () => {
  const vacio = new Sha256().digestHex();
  assert.equal(vacio, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

  const abc = new Sha256().update(new TextEncoder().encode('abc')).digestHex();
  assert.equal(abc, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  const largo = new Sha256()
    .update(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
    .digestHex();
  assert.equal(largo, '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('el millón de «a», que es el vector que destapa el acarreo de la longitud', () => {
  const h = new Sha256();
  const bloque = new Uint8Array(1000).fill(0x61);
  for (let i = 0; i < 1000; i += 1) h.update(bloque);
  assert.equal(h.digestHex(), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('los bordes del bloque y del relleno de longitud', () => {
  // 55 → la longitud cabe justo; 56 → hace falta un bloque más; 64 → bloque
  // exacto. Son los tres tamaños que rompen un relleno mal escrito.
  for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 127, 128, 129, 1000]) {
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) data[i] = (i * 31 + 7) & 0xff;
    assert.equal(feed(data, n || 1), hex(data), `tamaño ${n}`);
  }
});

test('el resultado no depende de cómo se trocee la entrada', () => {
  const data = new Uint8Array(4096);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 131 + 17) & 0xff;
  const esperado = hex(data);
  // Trozos que NO son múltiplos de 64 a propósito: es el caso que desalinea
  // una implementación que no completa el bloque pendiente antes de seguir.
  for (const chunk of [1, 7, 63, 64, 65, 100, 511, 1024, 4096]) {
    assert.equal(feed(data, chunk), esperado, `troceado en ${chunk}`);
  }
});

test('coincide con crypto.subtle sobre entradas aleatorias', async () => {
  for (let caso = 0; caso < 25; caso += 1) {
    const n = Math.floor(Math.random() * 5000);
    const data = new Uint8Array(n);
    webcrypto.getRandomValues(data);
    const nativo = Buffer.from(await webcrypto.subtle.digest('SHA-256', data)).toString('hex');
    assert.equal(feed(data, 1 + Math.floor(Math.random() * 200)), nativo, `caso ${caso} (${n} bytes)`);
  }
});

test('sha256HexOfBlob trocea y reporta avance', async () => {
  const data = new Uint8Array(3000);
  for (let i = 0; i < data.length; i += 1) data[i] = i & 0xff;
  const avances: number[] = [];
  const digest = await sha256HexOfBlob(new Blob([data]), (p) => avances.push(p.hashedBytes), 512);
  assert.equal(digest, hex(data));
  assert.deepEqual(avances, [512, 1024, 1536, 2048, 2560, 3000]);
  assert.equal(avances[avances.length - 1], data.length, 'el último avance es el total');
});

test('un blob vacío da el hash del vacío, sin dividir por cero', async () => {
  const digest = await sha256HexOfBlob(new Blob([]));
  assert.equal(digest, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('el trozo por defecto es grande pero no absurdo', () => {
  // Con 8 MiB, una reunión de 4 h a 128 kbps (~230 MB) son 29 lecturas, y el
  // pico de memoria es un trozo, no el fichero.
  assert.equal(HASH_CHUNK_BYTES, 8 * 1024 * 1024);
});

test('reutilizar el hash tras cerrarlo es un error, no un resultado silencioso', () => {
  const h = new Sha256();
  h.update(new TextEncoder().encode('abc'));
  h.digestHex();
  assert.throws(() => h.digestHex(), /dos veces/);
  assert.throws(() => h.update(new Uint8Array(1)), /después de digest/);
});
