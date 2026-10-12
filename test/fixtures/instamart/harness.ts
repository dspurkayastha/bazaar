/** Test harness: recorded Instamart fixtures behind a fake callTool. No MCP client, no network. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Place } from '../../../src/core/types.js';
import { toolResultToJson } from '../../../src/suppliers/instamart/mcp.js';
import type { CallTool } from '../../../src/suppliers/instamart/mcp.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8')) as T;
}

type Reply = unknown | ((args: Record<string, unknown>) => unknown);

export interface FakeTool {
  callTool: CallTool;
  calls: { name: string; args: Record<string, unknown> }[];
  /** Replace the reply for a tool. */
  set(name: string, reply: Reply): void;
  count(name: string): number;
}

/**
 * Each reply is a recorded tool result: either a plain JSON payload, or an MCP error envelope
 * ({isError:true, content:[...]}), which goes through the real toolResultToJson so errors become SupplierError
 * exactly as they do in production.
 */
export function fakeTool(replies: Record<string, Reply>): FakeTool {
  const table = new Map<string, Reply>(Object.entries(replies));
  const calls: FakeTool['calls'] = [];
  const callTool: CallTool = async (name, args = {}) => {
    calls.push({ name, args: structuredClone(args) });
    if (!table.has(name)) throw new Error(`fixture missing for tool ${name}`);
    const reply = table.get(name);
    const value = typeof reply === 'function' ? (reply as (a: Record<string, unknown>) => unknown)(args) : reply;
    const v = structuredClone(value) as { isError?: boolean; content?: unknown };
    if (v && typeof v === 'object' && 'isError' in v) return toolResultToJson(name, v);
    return toolResultToJson(name, { structuredContent: v });
  };
  return {
    callTool,
    calls,
    set: (name, reply) => void table.set(name, reply),
    count: (name) => calls.filter((c) => c.name === name).length,
  };
}

export const HOME: Place = {
  id: 'place_home',
  householdId: 'hh_1',
  key: 'home',
  nickname: 'home',
  aliases: [],
  canonicalAddress: 'MASKED, Silchar',
  city: 'Silchar',
  lat: 24.8,
  lng: 92.8,
  supplierAddressIds: { instamart: 'ADDR-HOME-MASKED' },
  serviceability: [],
  trusted: true,
  isDefault: true,
};

export const NOW = '2026-10-12T14:00:00.000Z';
