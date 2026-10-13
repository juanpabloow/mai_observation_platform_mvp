import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * REGRESSION: typing in the staff panel (Equipo → Details) lost focus after ONE key.
 * useFocusTrap re-ran its effect whenever `onClose` changed, and callers pass an inline
 * closure (new every render), so every keystroke re-engaged the trap and moved focus to
 * the panel's first control. The trap must depend only on `active` + `ref` and read the
 * latest onClose through a ref.
 */
const src = readFileSync(fileURLToPath(new URL('../../web/components/ui/Overlay.tsx', import.meta.url)), 'utf8');

test('the focus trap does not re-engage on every render', () => {
  const body = src.slice(src.indexOf('export function useFocusTrap'), src.indexOf('export function useTrappedPanel'));
  assert.ok(body.includes('const onCloseRef = useRef(onClose);'), 'latest onClose kept in a ref');
  assert.ok(body.includes('onCloseRef.current();'), 'Escape calls the latest onClose');
  assert.ok(body.includes('}, [active, ref]);'), 'the trap effect depends only on active + ref');
  assert.ok(!body.includes('[active, onClose, ref]'), 'onClose is not a dependency of the trap effect');
});
