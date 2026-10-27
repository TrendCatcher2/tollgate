import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Conversations, HttpError } from './conversations.js';

export interface Limits {
  /** Chat turns one visitor may send per window. */
  perVisitor: number;
  windowMs: number;
  /** Chat turns the whole server may send per day, to stay inside the free model quota. */
  perDay: number;
  disabled: boolean;
}

const MAX_BODY = 8 * 1024;
const MAX_MESSAGE = 2_000;

/** The demo web app: one page plus a small JSON API over Conversations. */
export function createDemoServer(convos: Conversations, limits: Limits, pagePath: string): Server {
  const visitors = new Map<string, number[]>();
  let day = new Date().toISOString().slice(0, 10);
  let turnsToday = 0;

  const takeTurn = (visitor: string, usesModel: boolean) => {
    if (limits.disabled) throw new HttpError(503, 'the demo is paused');
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) [day, turnsToday] = [today, 0];
    if (usesModel && turnsToday >= limits.perDay) throw new HttpError(429, 'the demo hit its daily limit; try again tomorrow or run it locally');
    const now = Date.now();
    const recent = (visitors.get(visitor) ?? []).filter((t) => now - t < limits.windowMs);
    if (recent.length >= limits.perVisitor) throw new HttpError(429, 'too many messages; wait a few minutes');
    recent.push(now);
    visitors.set(visitor, recent);
    if (usesModel) turnsToday += 1;
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, await readFile(pagePath), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/info') {
        return json(res, 200, { backend: convos.backendLabel, disabled: limits.disabled });
      }
      if (req.method === 'POST' && url.pathname === '/api/conversations') {
        const body = await readJson(req);
        // A live conversation creates sandbox payments, so it counts toward the visitor's limit.
        takeTurn(visitorOf(req), false);
        return json(res, 200, convos.view(await convos.create(body.guarded !== false, body.agent === 'hijacked' ? 'hijacked' : 'ai')));
      }
      const match = url.pathname.match(/^\/api\/conversations\/([0-9a-f-]{36})(?:\/(messages|approvals\/([0-9a-f-]{36})\/(approve|reject)))?$/);
      if (match) {
        const convo = convos.get(match[1]!);
        if (req.method === 'GET' && !match[2]) return json(res, 200, convos.view(convo));
        if (req.method === 'POST' && match[2] === 'messages') {
          const { message } = await readJson(req);
          if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE) {
            throw new HttpError(400, `message must be 1-${MAX_MESSAGE} characters`);
          }
          // Only real model turns spend the model quota; the per-visitor limit applies to both.
          takeTurn(visitorOf(req), convo.agent === 'ai');
          const reply = await convos.send(convo, message.trim());
          return json(res, 200, { reply, view: convos.view(convo) });
        }
        if (req.method === 'POST' && match[3]) {
          if (match[4] === 'approve') await convo.gate.approve(match[3]);
          else convo.gate.reject(match[3]);
          return json(res, 200, { view: convos.view(convo) });
        }
      }
      throw new HttpError(404, 'not found');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : /no pending approval/.test(String(err)) ? 404 : 500;
      if (status === 500) console.error(err);
      json(res, status, { error: status === 500 ? 'something went wrong; check the server log' : (err as Error).message });
    }
  });
}

function visitorOf(req: IncomingMessage): string {
  // Behind a hosting proxy, the last X-Forwarded-For entry is the one the proxy added; earlier ones are client-supplied.
  const forwarded = req.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
  return header?.split(',').at(-1)?.trim() || req.socket.remoteAddress || 'unknown';
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'request too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
