// Runs the spec suite (consultas.test.mjs: 14 synthetic scenarios) against the SQL text the
// dashboard actually ships (src/db/repositories/valueDashboardSql.ts), then the 20 mutations:
// each one reintroduces a bug found in review and MUST make at least one scenario fail.
//
//   TEST_DATABASE_URL=postgres://…@127.0.0.1:…/algo_test node --import tsx test/value-dashboard/run-spec.mjs
//
// Local *_test databases only (consultas.test.mjs refuses anything else). Every scenario runs
// inside a transaction that is rolled back.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VALUE_DASHBOARD_SQL } from "../../src/db/repositories/valueDashboardSql.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "value-sql-"));
const shipped = join(dir, "shipped.sql");
writeFileSync(shipped, VALUE_DASHBOARD_SQL);
const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL };

function suite(sqlFile) {
  const r = spawnSync(process.execPath, ["--test", join(here, "consultas.test.mjs")], {
    env: { ...env, SQL_FILE: sqlFile },
    encoding: "utf8",
  });
  const pass = Number(/^# pass (\d+)/m.exec(r.stdout)?.[1] ?? -1);
  const fail = Number(/^# fail (\d+)/m.exec(r.stdout)?.[1] ?? -1);
  return { pass, fail, out: r.stdout + r.stderr };
}

const base = suite(shipped);
console.log(`shipped SQL: pass ${base.pass}, fail ${base.fail}`);
if (base.fail !== 0 || base.pass !== 14) {
  console.log(base.out);
  process.exit(1);
}

const mutDir = join(dir, "mut");
spawnSync("mkdir", ["-p", mutDir]);
const gen = spawnSync("python3", [join(here, "mutaciones.py"), shipped, mutDir], { encoding: "utf8" });
if (gen.status !== 0) {
  console.log(gen.stdout + gen.stderr);
  process.exit(1);
}
let undetected = 0;
for (const f of readdirSync(mutDir).sort()) {
  const r = suite(join(mutDir, f));
  const ok = r.fail > 0;
  if (!ok) undetected++;
  console.log(`${ok ? "detected  " : "UNDETECTED"} ${f} (fail ${r.fail})`);
}
console.log(undetected === 0 ? "all mutations detected" : `${undetected} mutation(s) NOT detected`);
process.exit(undetected === 0 ? 0 : 1);
