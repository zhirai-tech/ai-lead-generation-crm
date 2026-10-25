import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';

let ctx;

before(async () => {
  ctx = await createTestContext();
});

after(async () => {
  await ctx.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test('companies API exposes persisted qualification tags', async () => {
  const created = await ctx.request('POST', '/api/v1/companies', {
    body: {
      name: 'Rheinland Autoteile GmbH',
      description: 'Kfz-Ersatzteile Großhandel für Händler und regionale Distributoren.',
      country: 'DE',
      tags: ['qualification:qualified', 'qualification_reason:verified'],
    },
  });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.body.data.qualification, 'qualified');

  const listed = await ctx.request('GET', '/api/v1/companies?q=Rheinland');
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.body.data.items[0].qualification, 'qualified');

  const fetched = await ctx.request('GET', `/api/v1/companies/${created.body.data.id}`);
  assert.equal(fetched.status, 200, fetched.text);
  assert.equal(fetched.body.data.company.qualification, 'qualified');
  assert.equal(fetched.body.data.company.qualificationReason, 'verified');
});
