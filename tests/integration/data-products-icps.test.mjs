import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../helpers.mjs';

let ctx;

before(async () => {
  ctx = await createTestContext();
});

after(async () => {
  await ctx.close();
});

async function createProduct(body) {
  const response = await ctx.request('POST', '/api/v1/products', { body });
  assert.equal(response.status, 200, response.text);
  return response.body.data;
}

test('product CRUD keeps user-provided specs and certifications only', async () => {
  const product = await createProduct({
    name: 'Ceramic Brake Pad',
    category: 'Brake System',
    sku: 'BP-CER-001',
    description: 'Low-dust ceramic brake pad for passenger cars.',
    specs: { width: '145mm', height: '63mm', thickness: '17mm' },
    applications: ['passenger car', 'aftermarket'],
    materials: 'ceramic compound',
    certifications: ['ECE R90', 'IATF 16949'],
    capacity: '200,000 sets / month',
    moq: '500 sets',
    pricingTerms: 'FOB Shanghai',
    samples: 'available',
    leadTime: '25 days',
  });
  assert.equal(product.name, 'Ceramic Brake Pad');
  assert.deepEqual(product.specs, { width: '145mm', height: '63mm', thickness: '17mm' });
  assert.deepEqual(product.applications, ['passenger car', 'aftermarket']);
  assert.deepEqual(product.certifications, ['ECE R90', 'IATF 16949']);
  assert.equal(product.capacity, '200,000 sets / month');
  assert.equal(product.moq, '500 sets');
  assert.equal(product.status, 'active');

  const bare = await createProduct({ name: 'Uncertified Bracket' });
  assert.deepEqual(bare.certifications, [], 'certifications must never be invented');
  assert.deepEqual(bare.specs, {});
  assert.equal(bare.capacity, null);

  const list = await ctx.request('GET', '/api/v1/products?q=Brake');
  assert.equal(list.status, 200, list.text);
  assert.equal(list.body.data.total, 1);
  assert.equal(list.body.data.items[0].id, product.id);

  const fetched = await ctx.request('GET', `/api/v1/products/${product.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.data.sku, 'BP-CER-001');

  const patched = await ctx.request('PATCH', `/api/v1/products/${product.id}`, {
    body: {
      status: 'draft',
      specs: { width: '150mm' },
      certifications: ['ECE R90'],
      moq: '600 sets',
    },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.body.data.status, 'draft');
  assert.deepEqual(patched.body.data.specs, { width: '150mm' });
  assert.deepEqual(patched.body.data.certifications, ['ECE R90']);
  assert.equal(patched.body.data.moq, '600 sets');

  const removed = await ctx.request('DELETE', `/api/v1/products/${product.id}`);
  assert.equal(removed.status, 200, removed.text);
  const gone = await ctx.request('GET', `/api/v1/products/${product.id}`);
  assert.equal(gone.status, 404);
});

test('product validation rejects empty names, bad status and invalid arrays', async () => {
  const empty = await ctx.request('POST', '/api/v1/products', { body: { name: '   ' } });
  assert.equal(empty.status, 422);
  const badStatus = await createProduct({ name: 'Status Product' });
  const patch = await ctx.request('PATCH', `/api/v1/products/${badStatus.id}`, { body: { status: 'retired' } });
  assert.equal(patch.status, 422);
  const badApps = await ctx.request('POST', '/api/v1/products', { body: { name: 'Bad Apps', applications: 'brake' } });
  assert.equal(badApps.status, 422);
});

test('ICP CRUD with target countries, keywords and linked product', async () => {
  const product = await createProduct({ name: 'ICP Product', category: 'Brake', applications: ['brake'] });
  const response = await ctx.request('POST', '/api/v1/icps', {
    body: {
      name: 'DACH brake distributors',
      description: 'Distributors and importers of brake parts in DACH.',
      productId: product.id,
      targetCountries: ['DE', 'at', 'CH'],
      targetRegions: ['western_europe'],
      targetCompanyTypes: ['distributor', 'importer'],
      targetSizes: ['11-50', '51-200'],
      targetRoles: ['decision_maker', 'technical'],
      includeKeywords: ['brake', 'aftermarket'],
      excludeKeywords: ['broker'],
      minScore: 55,
    },
  });
  assert.equal(response.status, 200, response.text);
  const icp = response.body.data;
  assert.deepEqual(icp.targetCountries, ['DE', 'AT', 'CH']);
  assert.deepEqual(icp.targetRegions, ['western_europe']);
  assert.deepEqual(icp.includeKeywords, ['brake', 'aftermarket']);
  assert.equal(icp.minScore, 55);
  assert.equal(icp.isActive, true);
  assert.equal(icp.productId, product.id);
  assert.equal(icp.productName, 'ICP Product');

  const list = await ctx.request('GET', `/api/v1/icps?productId=${product.id}`);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.body.data.total, 1);

  const patched = await ctx.request('PATCH', `/api/v1/icps/${icp.id}`, {
    body: { minScore: 70, excludeKeywords: ['broker', 'trader'], isActive: false },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.body.data.minScore, 70);
  assert.deepEqual(patched.body.data.excludeKeywords, ['broker', 'trader']);
  assert.equal(patched.body.data.isActive, false);

  const removed = await ctx.request('DELETE', `/api/v1/icps/${icp.id}`);
  assert.equal(removed.status, 200, removed.text);
  const gone = await ctx.request('GET', `/api/v1/icps/${icp.id}`);
  assert.equal(gone.status, 404);
});

test('ICP validation rejects out-of-range scores and unknown products', async () => {
  const badScore = await ctx.request('POST', '/api/v1/icps', { body: { name: 'Bad Score ICP', minScore: 150 } });
  assert.equal(badScore.status, 422);
  const badProduct = await ctx.request('POST', '/api/v1/icps', { body: { name: 'Bad Product ICP', productId: 'prd_missing' } });
  assert.equal(badProduct.status, 422);
  const badCountry = await ctx.request('POST', '/api/v1/icps', { body: { name: 'Bad Country ICP', targetCountries: ['Germany'] } });
  assert.equal(badCountry.status, 422);
});

test('products and ICPs are tenant isolated', async () => {
  const product = await createProduct({ name: 'Private Product' });
  const icp = await ctx.request('POST', '/api/v1/icps', { body: { name: 'Private ICP' } });
  assert.equal(icp.status, 200, icp.text);
  const isolated = ctx.createWorkspace();
  const originalAuth = ctx.auth;
  ctx.as(isolated);
  assert.equal((await ctx.request('GET', `/api/v1/products/${product.id}`)).status, 404);
  assert.equal((await ctx.request('GET', `/api/v1/icps/${icp.body.data.id}`)).status, 404);
  const productList = await ctx.request('GET', '/api/v1/products');
  assert.equal(productList.body.data.total, 0);
  const icpList = await ctx.request('GET', '/api/v1/icps');
  assert.equal(icpList.body.data.total, 0);
  ctx.auth = originalAuth;
});
