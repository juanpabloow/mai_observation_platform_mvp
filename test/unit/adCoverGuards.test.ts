import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  MAX_AD_COVER_DOWNLOAD_BYTES,
  META_CDN_HOST_SUFFIXES,
  detectCoverImage,
  isAllowedCoverUrl,
} from '../../src/attribution/coverGuards.js';

test('AT-2c isAllowedCoverUrl: only https Meta CDN hosts pass', () => {
  assert.equal(isAllowedCoverUrl('https://scontent.xx.fbcdn.net/v/t45/abc.jpg').ok, true);
  assert.equal(isAllowedCoverUrl('https://video-bog1-1.xx.fbcdn.net/o1/v/abc.jpg').ok, true);
  // http is refused (no plaintext).
  assert.deepEqual(isAllowedCoverUrl('http://scontent.xx.fbcdn.net/x.jpg'), { ok: false, reason: 'not_https' });
  // a non-Meta host is refused.
  assert.deepEqual(isAllowedCoverUrl('https://evil.example.com/x.jpg'), { ok: false, reason: 'host_not_allowed' });
  // suffix-confusion is refused: the host must END with ".fbcdn.net", not merely contain it.
  assert.equal(isAllowedCoverUrl('https://fbcdn.net.evil.com/x.jpg').ok, false, 'fbcdn.net.evil.com refused');
  assert.equal(isAllowedCoverUrl('https://notfbcdn.net/x.jpg').ok, false, 'notfbcdn.net refused');
  // garbage is refused.
  assert.deepEqual(isAllowedCoverUrl('not a url'), { ok: false, reason: 'bad_url' });
  assert.deepEqual(META_CDN_HOST_SUFFIXES, ['.fbcdn.net']);
});

test('AT-2c detectCoverImage: recognizes png/jpeg/webp by magic bytes, rejects others', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assert.deepEqual(detectCoverImage(png), { ext: 'png', contentType: 'image/png' });
  assert.deepEqual(detectCoverImage(jpeg), { ext: 'jpg', contentType: 'image/jpeg' });
  assert.deepEqual(detectCoverImage(webp), { ext: 'webp', contentType: 'image/webp' });
  // an HTML page (e.g. an error page) or a GIF is NOT an accepted image.
  assert.equal(detectCoverImage(new Uint8Array([0x3c, 0x21, 0x44, 0x4f])), null); // "<!DO..."
  assert.equal(detectCoverImage(new Uint8Array([0x47, 0x49, 0x46, 0x38])), null); // "GIF8"
  assert.equal(detectCoverImage(new Uint8Array([])), null);
});

test('AT-2c size cap is a sane abuse bound', () => {
  assert.equal(MAX_AD_COVER_DOWNLOAD_BYTES, 5 * 1024 * 1024);
});
