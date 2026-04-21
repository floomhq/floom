// Stress test for the RowTable CSV download helper (#282).
//
// RowTable exposes `rowsToCsv(rows, columns)` which every biz-user-
// facing run surface eventually calls. It needs to be RFC 4180-ish:
// commas / newlines / quotes inside a cell must be escaped, every row
// must have the same column count as the header, and null/undefined
// must serialise to empty (not "null"). If any of those slip, Excel and
// Sheets produce subtly broken CSVs that break the lead-scorer demo.

import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Import the ESM build target; tsx transpiles on the fly.
const mod = await import(
  pathToFileURL(
    resolve(
      import.meta.dirname,
      '../../apps/web/src/components/output/RowTable.tsx',
    ),
  ).href
);

const { rowsToCsv } = mod;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

// --- basic shape ------------------------------------------------------
check('header row matches columns', () => {
  const csv = rowsToCsv([{ a: 1, b: 2 }], ['a', 'b']);
  const [head] = csv.split('\r\n');
  assert.equal(head, 'a,b');
});

check('row count matches rows length + 1 (header)', () => {
  const csv = rowsToCsv(
    [{ a: 1 }, { a: 2 }, { a: 3 }],
    ['a'],
  );
  assert.equal(csv.split('\r\n').length, 4);
});

check('empty rows → header only', () => {
  const csv = rowsToCsv([], ['x', 'y']);
  assert.equal(csv, 'x,y');
});

// --- escaping ---------------------------------------------------------
check('value with comma is quoted', () => {
  const csv = rowsToCsv([{ a: 'hello, world' }], ['a']);
  assert.ok(csv.includes('"hello, world"'));
});

check('value with newline is quoted', () => {
  const csv = rowsToCsv([{ a: 'line1\nline2' }], ['a']);
  assert.ok(csv.includes('"line1\nline2"'));
});

check('value with quote is doubled and wrapped', () => {
  const csv = rowsToCsv([{ a: 'say "hi"' }], ['a']);
  assert.ok(csv.includes('"say ""hi"""'));
});

check('plain string not wrapped', () => {
  const csv = rowsToCsv([{ a: 'plain' }], ['a']);
  assert.ok(csv.endsWith('plain'));
  assert.ok(!csv.includes('"plain"'));
});

// --- value coercion ---------------------------------------------------
check('null → empty field', () => {
  const csv = rowsToCsv([{ a: null }], ['a']);
  assert.equal(csv, 'a\r\n');
});

check('undefined / missing → empty field', () => {
  const csv = rowsToCsv([{}], ['a']);
  assert.equal(csv, 'a\r\n');
});

check('number → plain digits, no quoting', () => {
  const csv = rowsToCsv([{ n: 42 }], ['n']);
  assert.ok(csv.endsWith('42'));
});

check('boolean → true/false literal', () => {
  const csv = rowsToCsv([{ ok: true }, { ok: false }], ['ok']);
  assert.ok(csv.includes('true'));
  assert.ok(csv.includes('false'));
});

check('nested object → JSON string', () => {
  const csv = rowsToCsv([{ meta: { a: 1 } }], ['meta']);
  // Result is quoted because JSON contains `"`.
  assert.ok(csv.includes('"{""a"":1}"'));
});

// --- column ordering --------------------------------------------------
check('column order follows `columns` array, not row key insertion', () => {
  const csv = rowsToCsv([{ b: 2, a: 1 }], ['a', 'b']);
  assert.equal(csv.split('\r\n')[1], '1,2');
});

check('missing row key → empty cell, no shift', () => {
  const csv = rowsToCsv([{ a: 1 }, { b: 2 }], ['a', 'b']);
  const lines = csv.split('\r\n');
  assert.equal(lines[1], '1,');
  assert.equal(lines[2], ',2');
});

// --- real-world-ish lead-scorer row ----------------------------------
check('lead-scorer row round-trips through Excel-style CSV', () => {
  const rows = [
    {
      company: 'Acme, Inc.',
      website: 'https://acme.example',
      fit_score: 87,
      notes: 'B2B SaaS\n"flagship" account',
    },
  ];
  const csv = rowsToCsv(rows, ['company', 'website', 'fit_score', 'notes']);
  // Header
  assert.equal(csv.split('\r\n')[0], 'company,website,fit_score,notes');
  // Body has 4 fields (commas only inside the quoted ones)
  const body = csv.split('\r\n')[1];
  assert.ok(body.includes('"Acme, Inc."'));
  assert.ok(body.includes('https://acme.example'));
  assert.ok(body.includes(',87,'));
  assert.ok(body.includes('"B2B SaaS\n""flagship"" account"'));
});

if (failed > 0) {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed`);
