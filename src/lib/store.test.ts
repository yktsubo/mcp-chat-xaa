import { afterEach, describe, expect, it, vi } from 'vitest';

const redis = {
  hgetall: vi.fn(),
  hdel: vi.fn(),
  del: vi.fn(),
  multi: vi.fn(),
};
const fromEnv = vi.fn(() => redis);
vi.mock('@upstash/redis', () => ({ Redis: { fromEnv: () => fromEnv() } }));

const { MemoryStore, getStore, redisClient, setStore } = await import('./store');

afterEach(() => {
  setStore(undefined);
  vi.clearAllMocks();
});

describe('MemoryStore', () => {
  it('reads, merges and removes fields', async () => {
    const store = new MemoryStore();
    expect(await store.get('k')).toEqual({});

    await store.set('k', { a: 1, b: { c: 2 } });
    await store.set('k', { d: 'x' });
    expect(await store.get('k')).toEqual({ a: 1, b: { c: 2 }, d: 'x' });

    await store.remove('k', ['a', 'd']);
    expect(await store.get('k')).toEqual({ b: { c: 2 } });
    await store.remove('missing', ['a']);

    await store.delete('k');
    expect(await store.get('k')).toEqual({});
  });

  it('returns copies, so callers cannot change what is stored', async () => {
    const store = new MemoryStore();
    await store.set('k', { b: { c: 2 } });
    const read = await store.get('k');
    (read.b as { c: number }).c = 99;
    expect(await store.get('k')).toEqual({ b: { c: 2 } });
  });
});

describe('getStore', () => {
  it('has no Redis client without connection details', () => {
    expect(redisClient({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('uses memory when Redis is not configured (local development)', () => {
    const store = getStore({} as NodeJS.ProcessEnv);
    expect(store).toBeInstanceOf(MemoryStore);
    expect(getStore({} as NodeJS.ProcessEnv)).toBe(store);
  });

  it('refuses to run on Vercel without Redis', () => {
    expect(() => getStore({ VERCEL: '1' } as NodeJS.ProcessEnv)).toThrow(/Redis is not configured/);
  });

  it.each([
    { KV_REST_API_URL: 'https://kv', KV_REST_API_TOKEN: 't' },
    { UPSTASH_REDIS_REST_URL: 'https://kv', UPSTASH_REDIS_REST_TOKEN: 't' },
  ])('uses Upstash Redis when its connection details are set (%o)', async (env) => {
    const exec = vi.fn();
    const expire = vi.fn(() => ({ exec }));
    const hset = vi.fn(() => ({ expire }));
    redis.multi.mockReturnValue({ hset });
    redis.hgetall.mockResolvedValueOnce({ tokens: { access_token: 'a' } }).mockResolvedValueOnce(null);

    const store = getStore(env as unknown as NodeJS.ProcessEnv);
    expect(fromEnv).toHaveBeenCalled();
    expect(await store.get('k')).toEqual({ tokens: { access_token: 'a' } });
    expect(await store.get('k')).toEqual({});

    await store.set('k', { state: 's' }, 60);
    expect(hset).toHaveBeenCalledWith('k', { state: 's' });
    expect(expire).toHaveBeenCalledWith('k', 60);
    expect(exec).toHaveBeenCalled();

    await store.remove('k', ['state', 'verifier']);
    expect(redis.hdel).toHaveBeenCalledWith('k', 'state', 'verifier');

    await store.delete('k');
    expect(redis.del).toHaveBeenCalledWith('k');
    expect(redisClient(env as unknown as NodeJS.ProcessEnv)).toBe(redis);
  });
});
