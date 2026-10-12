import type { FastifyBaseLogger } from 'fastify';
import { runShopRequestDetailed, type RunOptions } from '../agent/loop.js';
import type { RequestTelemetry } from '../agent/trace.js';
import type { ShopRequest, ShopResult } from '../core/types.js';
import type { ApiDeps } from './http.js';

/**
 * Run a shop request and write the one structured trace line for it (info, event "shop_request"): requestId, placeId,
 * model, toolCalls [{name, ms, ok, errorKind?, errorMessage?}], totalMs, outcome, usage. The telemetry carries no tool
 * arguments, member tokens, API keys, addresses or phone numbers.
 */
export async function runLogged(
  request: ShopRequest,
  deps: ApiDeps,
  log: FastifyBaseLogger,
  opts: RunOptions = {},
): Promise<{ result: ShopResult; telemetry: RequestTelemetry }> {
  const { result, telemetry } = await runShopRequestDetailed(request, deps, opts);
  log.info({ event: 'shop_request', ...telemetry }, 'shop_request');
  return { result, telemetry };
}
