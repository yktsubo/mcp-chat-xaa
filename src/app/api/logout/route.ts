import type { NextRequest } from 'next/server';
import { currentUser } from '@/lib/auth';
import { errorFields, log } from '@/lib/log';
import { deleteUserData } from '@/lib/mcp';
import { logoutUrl } from '@/lib/okta';

// ログアウト: このユーザーの MCP のトークンを消し、Okta のセッションも終わらせる URL（OIDC RP-Initiated Logout）を返す。
// アプリのセッションは、画面が next-auth の signOut で消す
export async function POST(req: NextRequest) {
  const origin = new URL(req.url).origin;
  // 別のサイトから勝手にログアウトさせられないよう、同じオリジンからの呼び出しだけを受け付ける
  if (req.headers.get('origin') !== origin) return Response.json({ error: 'forbidden' }, { status: 403 });

  const user = await currentUser();
  if (!user) return Response.json({ url: `${origin}/` });

  await deleteUserData(user.id);
  log.info('logout', { user: user.id });
  try {
    return Response.json({ url: await logoutUrl(user.idToken, `${origin}/`) });
  } catch (error) {
    // Okta に問い合わせられなくても、アプリからはログアウトさせる
    log.warn('okta_logout_url_failed', { user: user.id, ...errorFields(error) });
    return Response.json({ url: `${origin}/` });
  }
}
