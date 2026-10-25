// Claude agent loop, run in the browser with the user's own API key.
// Manual loop (rather than the beta tool runner) so the UI can show each tool
// call as it happens, and so it works from a CDN import with no build step.
import Anthropic from 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.137.0/+esm';

export const MODELS = {
  'claude-opus-5-5': 'Claude Opus 5.5 — best',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 — faster, cheaper',
  'claude-haiku-5-5': 'Claude Haiku 5.5 — cheapest',
};

// Server-side refusal fallback is available for Opus 5.5 / Sonnet 5.5, not Haiku.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
// Dynamic-filtering web search needs Opus/Sonnet; Haiku uses the basic variant.
const webSearchType = (model) => (model === 'claude-haiku-5-5' ? 'web_search_20250305' : 'web_search_20260209');

export class TripAgent {
  // tools: { definitions: Tool[], validate(name, input) -> error|null, execute(name, input) -> any }
  // baseURL is optional: set it to route requests through your own proxy instead.
  constructor({ apiKey, baseURL, model, system, tools, countryCode, onEvent }) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, ...(baseURL ? { baseURL } : {}) });
    this.model = model;
    this.system = system;
    this.tools = tools;
    this.onEvent = onEvent;
    this.messages = [];
    this.stream = null;
    this.cancelled = false;
    this.serverTools = [{
      type: webSearchType(model),
      name: 'web_search',
      max_uses: 5,
      ...(countryCode ? { user_location: { type: 'approximate', country: countryCode } } : {}),
    }];
  }

  get busy() {
    return !!this.stream;
  }

  cancel() {
    this.cancelled = true;
    this.stream?.abort();
  }

  async send(content) {
    this.cancelled = false;
    this.messages.push({ role: 'user', content });
    let jsonRetries = 0;
    try {
      while (true) {
        const params = {
          model: this.model,
          max_tokens: 64000,
          system: this.system,
          tools: [...this.tools.definitions, ...this.serverTools],
          messages: this.messages,
          output_config: { effort: 'medium' },
          cache_control: { type: 'ephemeral' },
        };
        if (FALLBACK_MODELS.has(this.model)) {
          params.betas = ['server-side-fallback-2026-07-01'];
          params.fallbacks = 'default';
        }
        this.stream = this.client.beta.messages.stream(params);
        this.stream.on('text', (delta) => this.onEvent({ type: 'text', delta }));
        this.stream.on('contentBlock', (block) => {
          if (block.type === 'server_tool_use' && block.name === 'web_search') {
            this.onEvent({ type: 'status', text: `🌐 Searching the web: ${block.input?.query ?? ''}` });
          }
        });

        let message;
        try {
          message = await this.stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          // Only an unparseable streamed tool input is retried; API errors and cancels propagate.
          if (this.cancelled || err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
          continue;
        }

        this.messages.push({ role: 'assistant', content: message.content });

        if (message.stop_reason === 'pause_turn') continue; // long server-tool turn: resume
        if (message.stop_reason === 'refusal') {
          this.onEvent({ type: 'error', text: 'Claude declined this request.' });
          break;
        }
        const uses = message.content.filter((b) => b.type === 'tool_use');
        if (!uses.length) break;
        if (message.stop_reason === 'max_tokens') throw new Error('Response was cut off (max tokens).');

        // Sequential on purpose: trip edits must apply in the order Claude issued them.
        const results = [];
        for (const use of uses) {
          if (this.cancelled) {
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Cancelled by the user.' });
            continue;
          }
          const invalid = this.tools.validate(use.name, use.input);
          if (invalid) {
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: invalid });
            continue;
          }
          try {
            const out = await this.tools.execute(use.name, use.input);
            results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out) });
          } catch (err) {
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: err.message });
          }
        }
        this.messages.push({ role: 'user', content: results });
        if (this.cancelled) break;
      }
    } catch (err) {
      if (!this.cancelled) throw describe(err);
    } finally {
      this.stream = null;
      this.onEvent({ type: 'done' });
    }
  }
}

function describe(err) {
  if (err instanceof Anthropic.AuthenticationError) return new Error('Your Claude API key was rejected — check it in Settings.');
  if (err instanceof Anthropic.PermissionDeniedError) return new Error('This API key is not allowed to use that model.');
  if (err instanceof Anthropic.RateLimitError) return new Error('Rate limited by the Claude API — try again in a moment.');
  if (err instanceof Anthropic.APIConnectionError) return new Error('Could not reach the Claude API — check your connection.');
  if (err instanceof Anthropic.APIError) return new Error(`Claude API error ${err.status ?? ''}: ${err.message}`);
  return err;
}
