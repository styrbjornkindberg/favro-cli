/**
 * AI Provider Abstraction
 *
 * Provider-agnostic interface for LLM completions.
 * Supports Anthropic Claude, OpenAI GPT, and Ollama (local).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AICompletionOptions {
  maxTokens?: number;
  temperature?: number;
  /** If true, return the full response at once (no streaming) */
  noStream?: boolean;
}

export interface AIProvider {
  readonly name: string;
  /**
   * Generate a completion. Yields chunks for streaming output.
   * Concatenate all chunks for the full response.
   */
  complete(system: string, messages: AIMessage[], options?: AICompletionOptions): AsyncIterable<string>;
}

// ─── Anthropic Provider ───────────────────────────────────────────────────────

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? 'claude-sonnet-4-20250514';
  }

  async *complete(system: string, messages: AIMessage[], options?: AICompletionOptions): AsyncIterable<string> {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: this.apiKey });

    const stream = client.messages.stream({
      model: this.model,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.3,
      system,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }
}

// ─── OpenAI Provider ──────────────────────────────────────────────────────────

export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? 'gpt-4o';
  }

  async *complete(system: string, messages: AIMessage[], options?: AICompletionOptions): AsyncIterable<string> {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: this.apiKey });

    const stream = await client.chat.completions.create({
      model: this.model,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.3,
      stream: true,
      messages: [
        { role: 'system' as const, content: system },
        ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      ],
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) yield text;
    }
  }
}

// ─── Ollama Provider (Local) ──────────────────────────────────────────────────

export class OllamaProvider implements AIProvider {
  readonly name = 'ollama';
  private baseUrl: string;
  private model: string;

  constructor(model?: string, baseUrl?: string) {
    this.model = model ?? 'llama3.1';
    this.baseUrl = baseUrl ?? 'http://localhost:11434';
  }

  async *complete(system: string, messages: AIMessage[], options?: AICompletionOptions): AsyncIterable<string> {
    const axios = (await import('axios')).default;

    const response = await axios.post(
      `${this.baseUrl}/api/chat`,
      {
        model: this.model,
        stream: true,
        messages: [
          { role: 'system', content: system },
          ...messages.map(m => ({ role: m.role, content: m.content })),
        ],
        options: {
          temperature: options?.temperature ?? 0.3,
          num_predict: options?.maxTokens ?? 4096,
        },
      },
      { responseType: 'stream' },
    );

    let buffer = '';
    for await (const chunk of response.data) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (parsed.message?.content) {
          yield parsed.message.content;
        }
      }
    }
  }
}

// ─── Provider Factory ─────────────────────────────────────────────────────────

export interface AIConfig {
  provider: 'anthropic' | 'openai' | 'ollama';
  model?: string;
  apiKey?: string;
  ollamaBaseUrl?: string;
}

/**
 * Create an AIProvider from config.
 * Resolves API key from config, then env vars.
 */
export function createAIProvider(config: AIConfig): AIProvider {
  switch (config.provider) {
    case 'anthropic': {
      const key = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error('Anthropic API key not configured.\n  Run `favro ai setup` or set ANTHROPIC_API_KEY.');
      return new AnthropicProvider(key, config.model);
    }
    case 'openai': {
      const key = config.apiKey ?? process.env.OPENAI_API_KEY;
      if (!key) throw new Error('OpenAI API key not configured.\n  Run `favro ai setup` or set OPENAI_API_KEY.');
      return new OpenAIProvider(key, config.model);
    }
    case 'ollama':
      return new OllamaProvider(config.model, config.ollamaBaseUrl);
    default:
      throw new Error(`Unknown AI provider: ${config.provider}. Supported: anthropic, openai, ollama`);
  }
}

/**
 * Collect all chunks from a streaming completion into a single string.
 */
export async function collectCompletion(stream: AsyncIterable<string>): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of stream) {
    parts.push(chunk);
  }
  return parts.join('');
}
