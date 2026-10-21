import { Redis } from '@upstash/redis';

// サーバー側の保存先。Vercel では Upstash Redis（Vercel の Storage から作ると KV_REST_API_URL / KV_REST_API_TOKEN が入る）。
// ローカル開発で接続情報が無いときだけ、プロセスのメモリに保存する。
// 値は項目（フィールド）ごとに読み書きするので、同時に動く別のリクエストが他の項目を上書きしない。
export interface HashStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(key: string, fields: Record<string, unknown>, ttlSeconds: number): Promise<void>;
  remove(key: string, fields: string[]): Promise<void>;
  delete(key: string): Promise<void>;
}

class RedisStore implements HashStore {
  constructor(private redis: Redis) {}

  async get(key: string) {
    return (await this.redis.hgetall<Record<string, unknown>>(key)) ?? {};
  }

  async set(key: string, fields: Record<string, unknown>, ttlSeconds: number) {
    await this.redis.multi().hset(key, fields).expire(key, ttlSeconds).exec();
  }

  async remove(key: string, fields: string[]) {
    await this.redis.hdel(key, ...fields);
  }

  async delete(key: string) {
    await this.redis.del(key);
  }
}

export class MemoryStore implements HashStore {
  private data = new Map<string, Record<string, unknown>>();

  async get(key: string) {
    return structuredClone(this.data.get(key) ?? {});
  }

  async set(key: string, fields: Record<string, unknown>) {
    this.data.set(key, { ...this.data.get(key), ...structuredClone(fields) });
  }

  async remove(key: string, fields: string[]) {
    const current = this.data.get(key);
    if (current) for (const field of fields) delete current[field];
  }

  async delete(key: string) {
    this.data.delete(key);
  }
}

const hasRedis = (env: NodeJS.ProcessEnv) =>
  !!(env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL) && !!(env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN);

let redis: Redis | undefined;

/** Upstash Redis のクライアント。接続情報が無ければ undefined */
export function redisClient(env: NodeJS.ProcessEnv = process.env): Redis | undefined {
  if (!redis && hasRedis(env)) redis = Redis.fromEnv();
  return redis;
}

let store: HashStore | undefined;

export function getStore(env: NodeJS.ProcessEnv = process.env): HashStore {
  if (store) return store;
  const client = redisClient(env);
  if (client) {
    store = new RedisStore(client);
  } else if (env.VERCEL) {
    // Vercel の関数はインスタンスごとにメモリが別なので、メモリに保存すると接続が壊れる
    throw new Error('Redis is not configured: connect Upstash Redis to this project in Vercel (Storage)');
  } else {
    store = new MemoryStore();
  }
  return store;
}

/** テスト用: 保存先を差し替える */
export function setStore(next: HashStore | undefined) {
  store = next;
  redis = undefined;
}
