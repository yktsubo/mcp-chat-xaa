import { afterEach, describe, expect, it, vi } from 'vitest';

const limit = vi.fn();
const slidingWindow = vi.fn((tokens: number, window: string) => ({ tokens, window }));
const Ratelimit = Object.assign(
  vi.fn(function (this: Record<string, unknown>, options: unknown) {
    Object.assign(this, { options, limit });
  }),
  { slidingWindow: (tokens: number, window: string) => slidingWindow(tokens, window) },
);
vi.mock('@upstash/ratelimit', () => ({ Ratelimit }));

const redis = { name: 'redis' };
const redisClient = vi.fn();
vi.mock('./store', () => ({ redisClient: () => redisClient() }));

const { checkChatLimit, resetChatLimiter } = await import('./ratelimit');

afterEach(() => {
  resetChatLimiter();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('checkChatLimit', () => {
  it('does not limit without Redis (local development)', async () => {
    redisClient.mockReturnValue(undefined);
    expect(await checkChatLimit('u1')).toEqual({ success: true });
    expect(Ratelimit).not.toHaveBeenCalled();
  });

  it('allows up to CHAT_RATE_LIMIT_PER_MINUTE requests per user per minute (10 by default)', async () => {
    redisClient.mockReturnValue(redis);
    limit.mockResolvedValue({ success: true, reset: 0 });
    expect(await checkChatLimit('u1')).toEqual({ success: true });
    await checkChatLimit('u1');
    expect(Ratelimit).toHaveBeenCalledTimes(1);
    expect(Ratelimit.mock.calls[0][0]).toMatchObject({ redis, prefix: 'ratelimit:chat', limiter: { tokens: 10, window: '1 m' } });
    expect(limit).toHaveBeenCalledWith('u1');

    resetChatLimiter();
    vi.stubEnv('CHAT_RATE_LIMIT_PER_MINUTE', '3');
    await checkChatLimit('u1');
    expect(slidingWindow).toHaveBeenLastCalledWith(3, '1 m');
  });

  it('tells how long to wait when the limit is reached', async () => {
    redisClient.mockReturnValue(redis);
    limit.mockResolvedValueOnce({ success: false, reset: Date.now() + 4200 }).mockResolvedValueOnce({ success: false, reset: 0 });
    expect(await checkChatLimit('u1')).toEqual({ success: false, retryAfterSeconds: 5 });
    expect(await checkChatLimit('u1')).toEqual({ success: false, retryAfterSeconds: 1 });
  });
});
