import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * AUDIT F4/C4 — the Contacts row control linked to the LEGACY `/contacts/{id}`, which
 * renders outside `/clients/{id}`: for a moment the no-client shell ("Elige un cliente")
 * showed before the server redirect landed. Internal links must carry the business.
 */
const web = fileURLToPath(new URL('../../web/', import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'api') continue; // HTTP API paths, not page links
      out.push(...sources(p));
    } else if (/\.(tsx?|ts)$/.test(name)) out.push(p);
  }
  return out;
}

// The module pages that exist ONLY under /clients/{id} (the top-level ones are legacy
// redirects or no-client shells).
const SCOPED = /(?:href=\{?|router\.(?:push|replace)\()\s*[`"']\/(contacts|inbox|workflows|scheduling\/(?:agenda|staff|admin))(?=[/`"'?$])/;

test('no page link drops the business from the route', () => {
  const offenders: string[] = [];
  for (const file of [...sources(join(web, 'components')), ...sources(join(web, 'lib'))]) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (SCOPED.test(line)) offenders.push(`${file.slice(web.length)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(offenders, []);
});

test('the Contacts row opens the record inside the validated client, and says so', () => {
  const table = readFileSync(join(web, 'components/contacts/ContactsTable.tsx'), 'utf8');
  assert.match(table, /href=\{`\/clients\/\$\{clientId\}\/contacts\/\$\{c\.id\}`\}/);
  assert.doesNotMatch(table, /href=\{`\/contacts\//);
  // It is a link to the record, not a menu: no `···` glyph promising one.
  assert.doesNotMatch(table, />\s*···\s*</);
  assert.match(table, /aria-label=\{`Abrir la ficha de /);

  const page = readFileSync(join(web, 'app/clients/[clientId]/contacts/page.tsx'), 'utf8');
  assert.match(page, /<ContactsTable\s+clientId=\{client\.id\}/, 'the page passes the VALIDATED client');
});
