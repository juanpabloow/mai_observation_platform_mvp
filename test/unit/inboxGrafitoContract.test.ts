import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Inbox · Grafito (palette 3a, «Inbox oscuro aprobado»): a visual update only — dark-only,
// scoped to the Inbox, with every current function kept.
const r = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

test('the palette is dark-only and scoped to the Inbox root', () => {
  const css = r('web/app/inbox-grafito.css');
  assert.ok(r('web/app/globals.css').startsWith('@import "tailwindcss";\n/* Inbox · Grafito (palette 3a): dark-only tokens scoped to `.u-ib`. */\n@import "./inbox-grafito.css";'));
  assert.ok(r('web/components/ClientInboxWorkspace.tsx').includes('<PageShell as="main" row ariaLabel="Inbox" className="u-ib '));
  // Every rule but the "hide the icon chip" default is under `.dark .u-ib` — Claro is untouched.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}@]+\{/g) ?? [];
  for (const sel of rules.map((s) => s.replace('{', '').trim()).filter((s) => s && !s.startsWith('media'))) {
    if (sel === '.u-ib [data-ib-who-icon]') continue;
    for (const part of sel.split(',')) assert.ok(part.trim().startsWith('.dark .u-ib'), `dark-only: ${part.trim()}`);
  }
  for (const v of ['--surface: #16171a', '--thread-bg: #0e0f11', '--chip: #1f2125', '--line: #2a2c31', '--foreground: #ececee', '--muted: #a6a6ae', '--faint: #80808a', '--queue-row-active: #24262b', '--bubble-in: #24262b', '--bubble-in-border: #2f3136', '--bubble-bot: #e9e9ec', '--bubble-bot-fg: #16171a', '--bubble-agent: #e9e9ec']) {
    assert.ok(css.includes(v), v);
  }
  assert.ok(css.includes('[data-ib-row][aria-current="page"] { border-color: #34363c; background: #24262b; }'), 'selected row');
});

test('who wrote stays in words when bot and team share the light bubble', () => {
  const t = r('web/components/MessageTranscript.tsx');
  assert.ok(t.includes(': isAgent ? (mine ? `Tú${agentFirst ? ` (${agentFirst})` : ""}` : agentFirst ?? "Equipo") : "Bot";'), 'author label above the business side');
  assert.ok(t.includes('data-sender={msg.sender}') && t.includes('data-ib-time=""'), 'the light bubbles get a readable time');
});

test('every Inbox function is kept (history, search, filters, ficha, take/return, WhatsApp window)', () => {
  const thread = r('web/components/InboxThread.tsx');
  assert.ok(thread.includes('Historial antes del escalado ·') && thread.includes('<HistoryDisclosure turns={history} />'), 'history: fold + reconstructed history');
  assert.ok(thread.includes('<ThreadActions plan={plan} busy={busy} onRequest={setConfirm} />') && thread.includes('<InboxConfirm'), 'take / return with confirmation');
  assert.ok(thread.includes('blockedReason={windowClosedLine(win, now)}') && thread.includes('{chip ? <StateChip kind={chip.open ? "open" : "closed"}>{chip.label}</StateChip> : null}'), 'the 24 h window');
  assert.ok(thread.includes('aria-label="Ficha del cliente"'), 'the ficha');
  // Who answers: an icon chip from md in Grafito, still named (aria-label + title); the text chip elsewhere.
  assert.ok(thread.includes('<span data-ib-who-icon="" data-kind={who.kind} role="img" aria-label={who.label} title={who.label}>'));
  const list = r('web/components/ClientInboxWorkspace.tsx');
  assert.ok(list.includes('aria-label="Buscar conversaciones"') && list.includes('<InboxTabs tab={tab} counts={counts} onChange={setTab} />') && list.includes('<WorkflowSelector'), 'search, tabs, workflow filter');
  assert.ok(r('web/components/Composer.tsx').includes('title="Las plantillas de WhatsApp aún no están conectadas" data-ib-template=""'), 'templates stay not connected');
});
