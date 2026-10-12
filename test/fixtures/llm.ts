/** A scripted stand-in for the Anthropic client: replays a fixed sequence of assistant turns. No network. */
import type { AssistantBlock, LlmClient, LlmRequest, LlmResponse, ToolResultBlock } from '../../src/agent/llm.js';

let n = 0;
export const say = (text: string): AssistantBlock => ({ type: 'text', text });
export const use = (name: string, input: unknown = {}): AssistantBlock => ({
  type: 'tool_use',
  id: `tu_${++n}`,
  name,
  input,
});

export type Step = AssistantBlock[] | ((req: LlmRequest) => AssistantBlock[]);

export class ScriptedLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private i = 0;
  constructor(private readonly steps: Step[]) {}

  async create(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps[this.i++];
    if (!step) {
      // Out of script: behave like a model that is done.
      return { content: [say('Done.')], stop_reason: 'end_turn' };
    }
    const content = typeof step === 'function' ? step(req) : step;
    return { content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' };
  }

  get calls(): number {
    return this.requests.length;
  }

  /** Tool results the model was shown in request `idx` (the last user turn). */
  resultsAt(idx: number): { is_error?: boolean; body: Record<string, unknown> }[] {
    const msgs = this.requests[idx]!.messages;
    const last = msgs[msgs.length - 1]!;
    if (last.role !== 'user' || typeof last.content === 'string') return [];
    return (last.content as ToolResultBlock[]).map((r) => ({
      ...(r.is_error ? { is_error: true } : {}),
      body: JSON.parse(r.content) as Record<string, unknown>,
    }));
  }
}

export const searchFor = (...queries: string[]): AssistantBlock[] => queries.map((query) => use('search', { query }));

export const asked = (variantId: string, quantity: number, itemKey?: string) => ({
  variantId,
  quantity,
  reason: { kind: 'asked', ...(itemKey ? { itemKey } : {}) },
});
