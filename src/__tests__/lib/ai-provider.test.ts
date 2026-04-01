/**
 * Tests for ai-provider.ts
 * AI provider abstraction — factory, config validation, collectCompletion
 */
import {
  createAIProvider,
  collectCompletion,
  AnthropicProvider,
  OpenAIProvider,
  OllamaProvider,
  AIConfig,
} from '../../lib/ai-provider';

describe('createAIProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('creates AnthropicProvider with explicit API key', () => {
    const provider = createAIProvider({ provider: 'anthropic', apiKey: 'sk-ant-test' });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe('anthropic');
  });

  test('creates AnthropicProvider from env var', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const provider = createAIProvider({ provider: 'anthropic' });
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  test('throws when Anthropic key missing', () => {
    expect(() => createAIProvider({ provider: 'anthropic' })).toThrow('Anthropic API key not configured');
  });

  test('creates OpenAIProvider with explicit API key', () => {
    const provider = createAIProvider({ provider: 'openai', apiKey: 'sk-test' });
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.name).toBe('openai');
  });

  test('creates OpenAIProvider from env var', () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    const provider = createAIProvider({ provider: 'openai' });
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  test('throws when OpenAI key missing', () => {
    expect(() => createAIProvider({ provider: 'openai' })).toThrow('OpenAI API key not configured');
  });

  test('creates OllamaProvider without API key', () => {
    const provider = createAIProvider({ provider: 'ollama' });
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.name).toBe('ollama');
  });

  test('creates OllamaProvider with custom base URL', () => {
    const provider = createAIProvider({ provider: 'ollama', ollamaBaseUrl: 'http://example.com:11434' });
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  test('throws on unknown provider', () => {
    expect(() => createAIProvider({ provider: 'unknown' as any })).toThrow('Unknown AI provider: unknown');
  });
});

describe('collectCompletion', () => {
  test('collects all chunks into a single string', async () => {
    async function* fakeStream() {
      yield 'Hello';
      yield ' ';
      yield 'World';
    }
    const result = await collectCompletion(fakeStream());
    expect(result).toBe('Hello World');
  });

  test('returns empty string for empty stream', async () => {
    async function* fakeStream() {
      // no chunks
    }
    const result = await collectCompletion(fakeStream());
    expect(result).toBe('');
  });

  test('handles single chunk stream', async () => {
    async function* fakeStream() {
      yield 'single chunk';
    }
    const result = await collectCompletion(fakeStream());
    expect(result).toBe('single chunk');
  });
});
