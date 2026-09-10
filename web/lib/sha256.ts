/**
 * SHA-256 incremental, para hashear un fichero por trozos en el navegador.
 *
 * ── Por qué no `crypto.subtle.digest` ──────────────────────────────────────
 *
 * `upload-complete` EXIGE el checksum (`UploadCompleteBody` lo tiene sin
 * `.optional()`), así que el navegador tiene que calcularlo antes de confirmar.
 * Y `crypto.subtle.digest` no tiene forma incremental: hay que darle el buffer
 * completo. El backend admite hasta 2 GiB por defecto
 * (`DEFAULT_MEDIA_LIMITS.maxBytes`), y meter 2 GiB en un `ArrayBuffer` para
 * hashearlo es la clase de cosa que funciona con el fichero de prueba de un
 * minuto y revienta con la reunión de cuatro horas que alguien suba de verdad.
 *
 * Esto procesa el fichero en trozos con memoria acotada: el estado son ocho
 * enteros de 32 bits y un búfer de 64 bytes, sin importar lo que mida el
 * fichero.
 *
 * ── Y por qué no una dependencia ──────────────────────────────────────────
 *
 * SHA-256 es una función de compresión de sesenta líneas con constantes fijas y
 * vectores de prueba publicados. `test/unit/sha256.test.ts` la compara contra
 * los vectores del NIST **y** contra `crypto.subtle` sobre entradas aleatorias,
 * incluidas las que caen justo en los bordes del bloque de 64 bytes y del
 * relleno de longitud. Una dependencia nueva en el bundle del navegador para
 * esto costaría más de lo que ahorra.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** El estado de un hash en curso. Ocho palabras y un bloque a medias. */
export class Sha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly w = new Uint32Array(64);
  private blockLength = 0;
  /** Longitud total en BITS. Se usa float porque 2 GiB en bits pasa de 2^31. */
  private totalBits = 0;
  private finished = false;

  update(chunk: Uint8Array): this {
    if (this.finished) throw new Error('Sha256: update() después de digest()');
    this.totalBits += chunk.length * 8;
    let offset = 0;
    // Se completa el bloque pendiente antes de consumir el trozo de corrido:
    // sin esto, un trozo que no es múltiplo de 64 desalinearía todo lo que
    // venga después, y el hash saldría mal sólo para ciertos tamaños.
    if (this.blockLength > 0) {
      const need = 64 - this.blockLength;
      const take = Math.min(need, chunk.length);
      this.block.set(chunk.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset = take;
      if (this.blockLength === 64) {
        this.compress(this.block, 0);
        this.blockLength = 0;
      }
    }
    while (offset + 64 <= chunk.length) {
      this.compress(chunk, offset);
      offset += 64;
    }
    if (offset < chunk.length) {
      this.block.set(chunk.subarray(offset), 0);
      this.blockLength = chunk.length - offset;
    }
    return this;
  }

  /** Cierra el hash y devuelve los 64 caracteres hexadecimales en minúsculas. */
  digestHex(): string {
    if (this.finished) throw new Error('Sha256: digest() dos veces');
    this.finished = true;

    const bits = this.totalBits;
    // Relleno: 0x80, ceros, y la longitud en 64 bits big-endian. Si no caben
    // los ocho bytes de longitud en este bloque, hace falta uno más — el caso
    // que las implementaciones caseras suelen equivocar.
    const padded = new Uint8Array(this.blockLength + 1 + 8 <= 64 ? 64 : 128);
    padded.set(this.block.subarray(0, this.blockLength), 0);
    padded[this.blockLength] = 0x80;
    const view = new DataView(padded.buffer);
    // La longitud se escribe como dos palabras de 32 bits: un `setBigUint64`
    // obligaría a BigInt por un valor que cabe de sobra en un double.
    view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000), false);
    view.setUint32(padded.length - 4, bits >>> 0, false);
    for (let offset = 0; offset < padded.length; offset += 64) this.compress(padded, offset);

    let out = '';
    for (let i = 0; i < 8; i += 1) out += this.h[i].toString(16).padStart(8, '0');
    return out;
  }

  private compress(data: Uint8Array, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    const hh = this.h;
    hh[0] = (hh[0] + a) >>> 0; hh[1] = (hh[1] + b) >>> 0;
    hh[2] = (hh[2] + c) >>> 0; hh[3] = (hh[3] + d) >>> 0;
    hh[4] = (hh[4] + e) >>> 0; hh[5] = (hh[5] + f) >>> 0;
    hh[6] = (hh[6] + g) >>> 0; hh[7] = (hh[7] + h) >>> 0;
  }
}

/** Trozos de 8 MiB: bastante grande para no trocear de más, bastante pequeño
 *  para que la pestaña no se quede sin memoria con una reunión de cuatro horas. */
export const HASH_CHUNK_BYTES = 8 * 1024 * 1024;

export interface HashProgress {
  readonly hashedBytes: number;
  readonly totalBytes: number;
}

/**
 * Hashea un `Blob`/`File` leyéndolo por trozos.
 *
 * `onProgress` existe porque hashear un fichero grande tarda lo bastante para
 * que sin señal parezca que la aplicación se colgó. Y cede el turno entre
 * trozos (`await`) para que la interfaz siga respondiendo: hacerlo en un bucle
 * síncrono congelaría la pestaña, que es peor que tardar.
 */
export async function sha256HexOfBlob(
  blob: Blob,
  onProgress?: (progress: HashProgress) => void,
  chunkBytes: number = HASH_CHUNK_BYTES,
): Promise<string> {
  const hash = new Sha256();
  const total = blob.size;
  let done = 0;
  while (done < total) {
    const end = Math.min(done + chunkBytes, total);
    const buffer = await blob.slice(done, end).arrayBuffer();
    hash.update(new Uint8Array(buffer));
    done = end;
    onProgress?.({ hashedBytes: done, totalBytes: total });
  }
  return hash.digestHex();
}
