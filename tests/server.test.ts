import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Conversations } from '../src/server/conversations.js';
import { createDemoServer } from '../src/server/http.js';

const convos = new Conversations({
  model: () => {
    throw new Error('the real model is not used in these tests');
  },
  live: null,
});
const server = createDemoServer(convos, { perVisitor: 50, windowMs: 60_000, perDay: 0, disabled: false }, 'public/index.html');
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = async (path: string, body: unknown) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

async function attack(guarded: boolean, scenarioId: string) {
  const convo = (await post('/api/conversations', { guarded, agent: 'hijacked' })).body;
  const scenario = (convo.scenarios as { id: string; message: string }[]).find((s) => s.id === scenarioId)!;
  return post(`/api/conversations/${convo.id}/messages`, { message: scenario.message });
}

describe('demo server', () => {
  it('serves the page', async () => {
    expect((await fetch(base + '/')).headers.get('content-type')).toContain('text/html');
  });

  it("lets a hijacked agent refund another customer's payment when Tollgate is off", async () => {
    const { status, body } = await attack(false, 'other-customer-refund');
    expect(status).toBe(200);
    expect(body.view.backendCalls).toMatchObject([{ tool: 'refund_transaction', ok: true }]);
  });

  it('blocks the same call before it reaches Braintree when Tollgate is on', async () => {
    const { body } = await attack(true, 'other-customer-refund');
    expect(body.view.backendCalls).toHaveLength(0);
    expect(body.view.events).toMatchObject([{ tool: 'refund_transaction', outcome: 'blocked', decision: { rule: 'not-your-order' } }]);
  });

  it('holds a dispute acceptance until a person approves it', async () => {
    const { body } = await attack(true, 'forged-dispute-email');
    expect(body.view.pending).toHaveLength(1);
    expect(body.view.backendCalls).toHaveLength(0);
    const approved = await post(`/api/conversations/${body.view.id}/approvals/${body.view.pending[0].id}/approve`, {});
    expect(approved.body.view.backendCalls).toMatchObject([{ tool: 'accept_dispute', ok: true }]);
    expect(approved.body.view.pending).toHaveLength(0);
  });

  it('hijacked turns do not spend the model quota, and real model turns respect it', async () => {
    const convo = (await post('/api/conversations', { guarded: true, agent: 'ai' })).body;
    const { status, body } = await post(`/api/conversations/${convo.id}/messages`, { message: 'hello' });
    expect(status).toBe(429);
    expect(body.error).toMatch(/daily limit/);
  });

  it('rejects free text for the hijacked agent and oversized messages', async () => {
    const convo = (await post('/api/conversations', { guarded: true, agent: 'hijacked' })).body;
    expect((await post(`/api/conversations/${convo.id}/messages`, { message: 'hello' })).status).toBe(400);
    expect((await post(`/api/conversations/${convo.id}/messages`, { message: 'x'.repeat(2_001) })).status).toBe(400);
  });
});

describe('per-visitor limit behind a proxy', () => {
  const limited = createDemoServer(convos, { perVisitor: 2, windowMs: 60_000, perDay: 0, disabled: false, clientIpHeader: 'cf-connecting-ip' }, 'public/index.html');
  let url = '';
  beforeAll(async () => {
    await new Promise<void>((resolve) => limited.listen(0, resolve));
    url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}/api/conversations`;
  });
  afterAll(() => new Promise<void>((resolve) => limited.close(() => resolve())));

  const start = async (headers: Record<string, string>) =>
    (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"agent":"hijacked"}' })).status;

  it('counts visitors by the trusted header, whatever X-Forwarded-For says', async () => {
    const amina = { 'cf-connecting-ip': '198.51.100.1' };
    expect(await start({ ...amina, 'x-forwarded-for': '10.0.0.1' })).toBe(200);
    expect(await start({ ...amina, 'x-forwarded-for': '10.0.0.2' })).toBe(200);
    expect(await start({ ...amina, 'x-forwarded-for': '203.0.113.9' })).toBe(429);
    expect(await start({ 'cf-connecting-ip': '198.51.100.2' })).toBe(200);
  });
});
