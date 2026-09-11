import { describe, expect, it, vi } from 'vitest';
import { buildOpenAIRequest, handleRequest } from './index';

const origin = 'https://salarshk.github.io';
const env = { OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-5.4-mini' };
const advisorRequest = (body, options = {}) => new Request('https://worker.example/advice', {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': options.ip || crypto.randomUUID() },
  body: JSON.stringify(body),
});

describe('advisor worker', () => {
  it('proxies the documented Wiener Linien feed endpoints', async () => {
    const fetchMock = vi.fn(async (url) => {
      expect(String(url)).toContain('https://www.wienerlinien.at/ogd_realtime/newsList?name=news');
      return new Response(JSON.stringify({ data: { pois: [] } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    const response = await handleRequest(new Request('https://worker.example/newsList?name=news', {
      method: 'GET', headers: { Origin: origin, 'CF-Connecting-IP': crypto.randomUUID() },
    }), env, fetchMock);
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(await response.json()).toEqual({ data: { pois: [] } });
  });

  it('answers an allowed CORS preflight', async () => {
    const response = await handleRequest(new Request('https://worker.example/advice', {
      method: 'OPTIONS', headers: { Origin: origin },
    }), env);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  });

  it('does not reflect a denied origin', async () => {
    const request = new Request('https://worker.example/advice', { method: 'POST', headers: { Origin: 'https://attacker.example' } });
    const response = await handleRequest(request, env);
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('fails safely when the server secret is missing', async () => {
    const response = await handleRequest(advisorRequest({ audience: 'passenger', goal: '', evidence: {} }), {});
    expect(response.status).toBe(503);
  });

  it('uses structured, non-stored Responses API output', async () => {
    const advice = {
      summary: 'U1 needs attention.', networkStatus: 'watch', lineDecisions: [], recommendations: [{
        title: 'Check U1', audience: 'passenger', action: 'Allow extra time.',
        rationale: 'A longer interval is visible.', evidence: ['U1 gap: 12 minutes'],
        affectedLines: ['U1'], confidence: 0.72, limitations: 'Position is inferred.',
      }],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      _request_id: 'req_test', output: [{ content: [{ type: 'output_text', text: JSON.stringify(advice) }] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const response = await handleRequest(advisorRequest({
      audience: 'passenger', goal: 'Avoid gaps', evidence: { headwayIssues: [] },
    }), env, fetchMock);
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.advice).toEqual(advice);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.store).toBe(false);
    expect(sent.model).toBe('gpt-5.4-mini');
    expect(sent.text.format.type).toBe('json_schema');
    expect(sent.text.format.strict).toBe(true);
  });

  it('asks Operations mode for a decision on every U-Bahn line', () => {
    const request = buildOpenAIRequest({ audience: 'operations', goal: '', evidence: {} }, env);
    expect(request.instructions).toContain('exactly one line decision for each of U1, U2, U3, U4, and U6');
    expect(request.instructions).toContain('human-reviewed decision-support recommendations only');
    expect(request.text.format.schema.required).toContain('lineDecisions');
    expect(request.text.format.schema.properties.lineDecisions.items.properties.line.enum)
      .toEqual(['U1', 'U2', 'U3', 'U4', 'U6']);
  });

  it('keeps the model configurable', () => {
    expect(buildOpenAIRequest({ audience: 'operations', goal: '', evidence: {} }, { OPENAI_MODEL: 'another-model' }).model)
      .toBe('another-model');
  });
});
