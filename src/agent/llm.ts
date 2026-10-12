/**
 * The slice of the Anthropic Messages API the loop uses, as plain types, so tests inject a scripted fake and
 * production wraps @anthropic-ai/sdk. Nothing here knows about tools or policy.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export type AssistantBlock = TextBlock | ToolUseBlock;

export type LlmMessage =
  { role: 'user'; content: string | ToolResultBlock[] } | { role: 'assistant'; content: AssistantBlock[] };

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface LlmRequest {
  model: string;
  max_tokens: number;
  system: string;
  tools: ToolSpec[];
  messages: LlmMessage[];
  /** 'none' forces a text-only answer (used when the tool budget is spent). */
  tool_choice?: { type: 'auto' } | { type: 'none' };
}

export interface LlmResponse {
  content: AssistantBlock[];
  stop_reason: string | null;
}

export interface LlmClient {
  create(req: LlmRequest): Promise<LlmResponse>;
}

export const DEFAULT_MODEL = 'claude-sonnet-4-5';

export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

/** Production client. Reads ANTHROPIC_API_KEY unless a key is passed. */
export function anthropicClient(apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): LlmClient {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set (see .env.example)');
  const client = new Anthropic({ apiKey });
  return {
    async create(req) {
      const res = await client.messages.create({
        model: req.model,
        max_tokens: req.max_tokens,
        system: req.system,
        tools: req.tools as Anthropic.Tool[],
        messages: req.messages as Anthropic.MessageParam[],
        ...(req.tool_choice ? { tool_choice: req.tool_choice as Anthropic.ToolChoice } : {}),
      });
      const content: AssistantBlock[] = [];
      for (const b of res.content) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
      }
      return { content, stop_reason: res.stop_reason };
    },
  };
}
