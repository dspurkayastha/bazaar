import type { FastifyInstance } from 'fastify';
import { makeRequest } from '../../agent/loop.js';
import type { ShopRequest } from '../../core/types.js';
import { memberOf, type AuthedMember } from '../auth.js';
import { ApiError, body, optString, reqString, type ApiDeps } from '../http.js';
import { runLogged } from '../run.js';

const CHANNELS = ['siri', 'whatsapp', 'web'] as const;

/**
 * Body → ShopRequest. The member and household come from the caller's credential (`who`), never from the body:
 * any `memberId` / `householdId` in the body is ignored. `id`, `receivedAt` and `channel` are filled in when absent.
 */
export function parseShopRequest(raw: unknown, deps: ApiDeps, who: AuthedMember): ShopRequest {
  const o = body(raw);
  const channel = optString(o, 'channel') ?? 'web';
  if (!(CHANNELS as readonly string[]).includes(channel))
    throw new ApiError(400, `channel must be one of ${CHANNELS.join(', ')}`);
  let context: ShopRequest['context'];
  if (o.context !== undefined) {
    const c = body(o.context);
    const num = (k: string) => {
      const v = c[k];
      if (v === undefined) return undefined;
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new ApiError(400, `context.${k} must be a number`);
      return v;
    };
    const lat = num('lat');
    const lng = num('lng');
    const calendarPlaceId = optString(c, 'calendarPlaceId');
    context = {
      ...(lat !== undefined ? { lat } : {}),
      ...(lng !== undefined ? { lng } : {}),
      ...(calendarPlaceId !== undefined ? { calendarPlaceId } : {}),
    };
  }
  const now = deps.now?.() ?? new Date().toISOString();
  return makeRequest(
    {
      householdId: who.householdId,
      memberId: who.memberId,
      text: reqString(o, 'text', 2000),
      channel: channel as ShopRequest['channel'],
      ...(optString(o, 'id') ? { id: optString(o, 'id')! } : {}),
      ...(optString(o, 'receivedAt') ? { receivedAt: optString(o, 'receivedAt')! } : {}),
      ...(context ? { context } : {}),
    },
    now,
  );
}

export function registerRequestRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post('/request', { config: { auth: 'member' } }, async (req) => {
    const { result, telemetry } = await runLogged(parseShopRequest(req.body, deps, memberOf(req)), deps, req.log);
    // `x-bazaar-debug: 1` adds the tool-call trace (names, timings, outcomes; no arguments) to the response.
    return req.headers['x-bazaar-debug'] === '1'
      ? { ...result, debug: { trace: telemetry.toolCalls, outcome: telemetry.outcome, totalMs: telemetry.totalMs } }
      : result;
  });
}
