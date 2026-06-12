import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { httpFetch } from '../../src/index.js';
import { NetworkError, RateLimitError } from '../../src/index.js';

describe('httpFetch', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed JSON on 2xx', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await httpFetch<{ ok: boolean }>('https://example.com');
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
  });

  it('throws NetworkError on 4xx other than 429', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    await expect(httpFetch('https://example.com')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws RateLimitError on 429', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('rate limited', { status: 429, headers: { 'retry-after': '1' } }),
    );
    await expect(httpFetch('https://example.com', { maxRateLimitRetries: 0 })).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it('retries 5xx with exponential backoff', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const res = await httpFetch('https://example.com', { maxRetries: 3 });
    expect(res.data).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does not retry 4xx other than 429', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('bad', { status: 400 }));
    await expect(httpFetch('https://example.com')).rejects.toBeInstanceOf(NetworkError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
