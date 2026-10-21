import { Ratelimit } from '@upstash/ratelimit';
import { redisClient } from './store';

// チャットの回数制限（ユーザーごと、直近 1 分間）。LLM の費用を守るため。
// 上限は CHAT_RATE_LIMIT_PER_MINUTE（既定 10）。Redis が無いローカル開発では制限しない。
let limiter: Ratelimit | undefined;

export type LimitResult = { success: true } | { success: false; retryAfterSeconds: number };

export async function checkChatLimit(user: string): Promise<LimitResult> {
  const redis = redisClient();
  if (!redis) return { success: true };
  limiter ??= new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(Number(process.env.CHAT_RATE_LIMIT_PER_MINUTE) || 10, '1 m'),
    prefix: 'ratelimit:chat',
  });
  const { success, reset } = await limiter.limit(user);
  return success ? { success } : { success, retryAfterSeconds: Math.max(1, Math.ceil((reset - Date.now()) / 1000)) };
}

/** テスト用: 作り直す */
export function resetChatLimiter() {
  limiter = undefined;
}
