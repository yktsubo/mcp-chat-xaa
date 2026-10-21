import { getServerSession, type NextAuthOptions } from 'next-auth';
import OktaProvider from 'next-auth/providers/okta';
import { errorFields, log } from './log';
import { assertionAudience, clientCredentials, refreshLogin } from './okta';

// アプリへのログイン（Okta の OIDC）。MCP サーバーへの認可とは別。
// セッションは暗号化 Cookie（next-auth の JWT）で、鍵は next-auth 標準の NEXTAUTH_SECRET。
// ID トークン（XAA の交換に使う）とリフレッシュトークンもセッションに入れるが、ブラウザには渡さない。

// ID トークンが切れるこの秒数前に更新する
const REFRESH_MARGIN_SECONDS = 60;

/**
 * withRefresh: 期限が近い ID トークンを更新するか。
 * next-auth のハンドラー（/api/auth/*）だけが Cookie を書き戻せるので、更新はそこでだけ行う。
 * それ以外（getServerSession）で更新すると、新しいリフレッシュトークンが保存されずに失われる。
 */
function createAuthOptions(withRefresh: boolean): NextAuthOptions {
  const { client, jwks } = clientCredentials(process.env.OKTA_CLIENT_ID!);
  return {
    providers: [
      OktaProvider({
        issuer: process.env.OKTA_ISSUER!,
        clientId: process.env.OKTA_CLIENT_ID!,
        clientSecret: process.env.OKTA_CLIENT_SECRET ?? '',
        client,
        jwks,
        authorization: { params: { scope: 'openid profile email offline_access' } },
        // next-auth の既定は state だけ。OAuth 2.1 / OIDC に沿って PKCE と nonce も検証する
        checks: ['pkce', 'state', 'nonce'],
        // private_key_jwt のときは、認可コードの交換でもクライアントアサーションの aud をトークンエンドポイントにする
        // （処理は next-auth の既定と同じ openid-client の callback。ID トークンの検証もそこで行われる）
        ...(jwks && {
          token: {
            request: async ({ client, params, checks, provider }) => ({
              tokens: await client.callback(provider.callbackUrl, params, checks, assertionAudience(client)),
            }),
          },
        }),
      }),
    ],
    callbacks: {
      async jwt({ token, account, profile }) {
        if (account) {
          return {
            ...token,
            username: (profile as { preferred_username?: string } | undefined)?.preferred_username,
            idToken: account.id_token,
            refreshToken: account.refresh_token,
            expiresAt: account.expires_at,
          };
        }
        const expiresAt = token.expiresAt as number | undefined;
        const fresh = !expiresAt || expiresAt - REFRESH_MARGIN_SECONDS > Date.now() / 1000;
        if (!withRefresh || fresh || !token.refreshToken) return token;
        try {
          const tokens = await refreshLogin(token.refreshToken as string);
          return {
            ...token,
            idToken: tokens.id_token ?? token.idToken,
            refreshToken: tokens.refresh_token ?? token.refreshToken,
            expiresAt: tokens.expires_at,
            error: undefined,
          };
        } catch (error) {
          log.warn('login_refresh_failed', { user: token.sub, ...errorFields(error) });
          return { ...token, error: 'RefreshFailed' };
        }
      },
      // ブラウザに渡るセッションには、ユーザー ID とユーザー名だけを入れる
      session: ({ session, token }) => ({ ...session, user: { ...session.user, id: token.sub, username: token.username } }),
    },
  };
}

/** next-auth のハンドラー用（ログイン、ログアウト、セッションの取得と更新） */
export const authOptions = createAuthOptions(true);

// サーバーの処理用。ID トークンも取り出せるようにする（この結果はブラウザに返さない）
const serverOptions: NextAuthOptions = {
  ...createAuthOptions(false),
  callbacks: {
    ...createAuthOptions(false).callbacks,
    session: ({ session, token }) => ({
      ...session,
      user: { ...session.user, id: token.sub, username: token.username },
      idToken: token.error ? undefined : token.idToken,
    }),
  },
};

type CurrentUser = { id: string; name: string; idToken?: string };

/** ログイン中のユーザー（ID、ユーザー名、XAA に使う ID トークン）。未ログインなら undefined */
export async function currentUser(): Promise<CurrentUser | undefined> {
  const session = (await getServerSession(serverOptions)) as {
    user?: { id?: string; username?: string; email?: string };
    idToken?: string;
  } | null;
  const user = session?.user;
  if (!user?.id) return undefined;
  return { id: user.id, name: user.username || user.email || user.id, idToken: session?.idToken };
}
