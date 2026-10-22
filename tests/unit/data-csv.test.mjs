import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsvRecords,
  parseCsvTable,
  escapeCsvValue,
  toCsv,
} from '../../server/services/imports.mjs';

test('CSV parser handles plain rows, CRLF and a trailing newline', () => {
  const records = parseCsvRecords('name,country\r\nAlpha,DE\r\nBeta,FR\r\n');
  assert.deepEqual(records, [
    ['name', 'country'],
    ['Alpha', 'DE'],
    ['Beta', 'FR'],
  ]);
});

test('CSV parser strips a UTF-8 BOM', () => {
  const records = parseCsvRecords('\uFEFFname,country\nAlpha,DE\n');
  assert.equal(records[0][0], 'name');
});

test('CSV parser supports quoted fields, embedded commas and escaped quotes', () => {
  const text = 'name,description\n"Alpha, GmbH","Leading ""aftermarket"" supplier, Europe"\n';
  const records = parseCsvRecords(text);
  assert.deepEqual(records[1], ['Alpha, GmbH', 'Leading "aftermarket" supplier, Europe']);
});

test('CSV parser supports embedded newlines inside quoted fields', () => {
  const text = 'name,notes\nAlpha,"line one\nline two"\nBeta,plain\n';
  const records = parseCsvRecords(text);
  assert.equal(records.length, 3);
  assert.equal(records[1][1], 'line one\nline two');
  assert.deepEqual(records[2], ['Beta', 'plain']);
});

test('CSV parser rejects an unclosed quote', () => {
  assert.throws(() => parseCsvRecords('name,notes\nAlpha,"unterminated\n'), /引号未闭合/);
});

test('parseCsvTable maps header columns and skips blank rows', () => {
  const table = parseCsvTable('name , domain ,\nAlpha,alpha.example\n\nBeta,beta.example\n');
  assert.deepEqual(table.header, ['name', 'domain', 'column_3']);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0].row, { name: 'Alpha', domain: 'alpha.example', column_3: '' });
  assert.equal(table.rows[1].rowNumber, 3);
});

test('parseCsvTable suffixes duplicate headers', () => {
  const table = parseCsvTable('email,email\na@b.com,c@d.com\n');
  assert.deepEqual(table.header, ['email', 'email_2']);
  assert.equal(table.rows[0].row.email_2, 'c@d.com');
});

test('escapeCsvValue quotes commas, quotes and newlines only when needed', () => {
  assert.equal(escapeCsvValue('plain'), 'plain');
  assert.equal(escapeCsvValue('a,b'), '"a,b"');
  assert.equal(escapeCsvValue('a"b'), '"a""b"');
  assert.equal(escapeCsvValue('a\nb'), '"a\nb"');
  assert.equal(escapeCsvValue(null), '');
});

test('toCsv round-trips through parseCsvRecords including BOM and CRLF', () => {
  const rows = [
    ['Alpha, GmbH', 'line1\nline2'],
    ['Beta', 'quote "inside"'],
  ];
  const csv = toCsv(['name', 'notes'], rows, { bom: true });
  assert.ok(csv.startsWith('\uFEFF'));
  const parsed = parseCsvRecords(csv);
  assert.deepEqual(parsed[0], ['name', 'notes']);
  assert.deepEqual(parsed[1], rows[0]);
  assert.deepEqual(parsed[2], rows[1]);
});

test('toCsv serialises objects by header key', () => {
  const csv = toCsv(['a', 'b'], [{ a: '1', b: 'x,y' }]);
  assert.equal(csv, 'a,b\r\n1,"x,y"\r\n');
});
