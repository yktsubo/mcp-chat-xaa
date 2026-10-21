import { auth } from '@ai-sdk/mcp';
import type { NextRequest } from 'next/server';
import { currentUser } from '@/lib/auth';
import { authorizationServerMetadata } from '@/lib/discovery';
import { errorFields, log } from '@/lib/log';
import { StoredOAuthProvider, mcpFetch, mcpServers } from '@/lib/mcp';

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// MCP サーバーの認可サーバー（Okta や Notion）からのリダイレクトを受け、認可コードをトークンに交換する
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';
  const server = mcpServers().find((s) => state.startsWith(`${s.name}.`));
  const user = (await currentUser())?.id;
  if (!code || !server || !user) {
    // 認可サーバーがエラーを返した（ユーザーが拒否したなど）、またはセッションや state が無い
    log.warn('mcp_oauth_callback_rejected', {
      server: server?.name,
      user,
      error: url.searchParams.get('error') ?? (!code ? 'no_code' : !server ? 'unknown_state' : 'no_session'),
      description: url.searchParams.get('error_description') ?? undefined,
    });
    return new Response(url.searchParams.get('error_description') ?? '不正なコールバックです', { status: 400 });
  }

  const authProvider = await StoredOAuthProvider.load(server, url.origin, user);
  const label = server.label ?? server.name;

  // RFC 9207 §2.4: 認可サーバーが iss を付けると宣言しているのに無ければ、受け付けない（mix-up 対策）。
  // 値の照合は SDK が行うが、iss が無い場合は SDK が照合を省くため、ここで確かめる
  const iss = url.searchParams.get('iss');
  const authServer = authProvider.authorizationServerInformation();
  if (!iss && authServer) {
    const metadata = (await authorizationServerMetadata(authServer.issuer ?? authServer.authorizationServerUrl)) as {
      authorization_response_iss_parameter_supported?: boolean;
    };
    if (metadata.authorization_response_iss_parameter_supported) {
      log.warn('mcp_oauth_callback_rejected', { server: server.name, user, error: 'missing_iss' });
      return new Response('認可レスポンスに iss がありません', { status: 400 });
    }
  }
  try {
    await auth(authProvider, {
      serverUrl: server.url,
      authorizationCode: code,
      callbackState: state, // 保存した state との照合は SDK が行う
      callbackIssuer: iss ?? undefined,
      fetchFn: mcpFetch,
    });
  } catch (error) {
    // 失敗の理由を画面に出す（認可コードは使い切りなので、やり直すにはチャットからもう一度接続する）
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log.error('mcp_oauth_callback_failed', { server: server.name, user, ...errorFields(error) });
    return new Response(`${label} に接続できませんでした。\n${reason}\n\nチャットに戻って、もう一度「接続」を押してください。`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  log.info('mcp_connected', { server: server.name, user });

  // 接続は別タブで開いているので、チャット画面に接続したことを知らせてから、そのタブを閉じる
  // HTML と script に埋め込む値はエスケープする（< はスクリプトの終わりと誤認されないよう \u003c に）
  const message = JSON.stringify({ type: 'mcp-connected', server: server.name, label }).replace(/</g, '\\u003c');
  return new Response(
    `<p>${escapeHtml(label)} に接続しました。このタブを閉じて、チャットでもう一度依頼してください。</p>` +
      `<script>window.opener?.postMessage(${message}, location.origin); window.close()</script>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}
