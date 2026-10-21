import {
  auth,
  createMCPClient,
  UnauthorizedError,
  type MCPClient,
  type OAuthAuthorizationServerInformation,
  type OAuthClientInformation,
  type OAuthClientProvider,
  type OAuthTokens,
} from '@ai-sdk/mcp';
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { randomUUID } from 'crypto';
import { authorizationServerFor, authorizationServerMetadata, resourceInfo } from './discovery';
import { errorFields, log } from './log';
import { exchangeIdToken } from './okta';
import { getStore } from './store';

// MCP_SERVERS: MCP サーバーの一覧（JSON 配列）
// name: ID（英数字と -。ツール名の接頭辞と保存先の鍵に使う） / label: 画面に出す名前（省略時は name）
// description: 何ができるサーバーか（未接続のとき、モデルが接続を求めるかの判断に使う）
// auth: "oauth"（既定。ユーザーが「接続」を押して MCP 標準の OAuth で接続する）または
//       "xaa"（Okta の Cross App Access。ログインの ID トークンから自動でトークンを得る。接続の操作は不要）
// issuer: 使う認可サーバー（省略時は Protected Resource Metadata の先頭。指定時はそこに載っていることを確かめる）
// scope: XAA で要求するスコープ
// xaa_resource: XAA の ID-JAG の要求に resource（MCP サーバーの識別子）を付ける（仕様上 OPTIONAL。既定は付けない）
// client_id / client_secret: 事前登録したクライアント（oauth で省略時は CIMD、使えなければ動的クライアント登録）
export type McpServer = {
  name: string;
  label?: string;
  url: string;
  description?: string;
  auth?: 'oauth' | 'xaa';
  issuer?: string;
  scope?: string;
  xaa_resource?: boolean;
  client_id?: string;
  client_secret?: string;
};

export function mcpServers(): McpServer[] {
  return JSON.parse(process.env.MCP_SERVERS || '[]');
}

const labelOf = (name: string) => mcpServers().find((m) => m.name === name)?.label ?? name;
const keyOf = (user: string, server: string) => `mcp:${user}:${server}`;

// 保存期間（最後に書き込んでから）。期限が切れたら接続し直しになる
const TTL_SECONDS = 60 * 60 * 24 * 30;
// XAA のトークンを使い回す余裕（期限のこの秒数前に取り直す）
const XAA_MARGIN_SECONDS = 60;

type Stored = {
  client?: OAuthClientInformation;
  tokens?: OAuthTokens & { expires_at?: number };
  verifier?: string;
  state?: string;
  authServer?: OAuthAuthorizationServerInformation;
  /** MCP サーバーが insufficient_scope で求めたスコープ（追加の認可が済むまで残す） */
  stepUpScope?: string;
};

/** このアプリの OAuth クライアントとしての情報（動的クライアント登録と CIMD の文書に使う） */
export function clientMetadata(origin: string, tokenEndpointAuthMethod = 'none') {
  return {
    client_name: 'MCP Chat',
    client_uri: origin,
    redirect_uris: [`${origin}/api/mcp/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: tokenEndpointAuthMethod,
  };
}

/** CIMD（OAuth Client ID Metadata Document）の URL。これがそのまま client_id になる */
export const clientMetadataDocumentUrl = (origin: string) => `${origin}/oauth/client-metadata.json`;

/**
 * 認可サーバーが CIMD に対応していれば、その client_id と認可サーバーを返す（https で公開されているときだけ使える）。
 * client_id は、その認可サーバー専用として扱う（SDK はクライアント情報と認可サーバーの結び付きを求める）
 */
async function cimdClient(server: McpServer, origin: string): Promise<OAuthClientInformation | undefined> {
  if (!origin.startsWith('https:')) return undefined;
  try {
    const issuer = await authorizationServerFor(server.url, server.issuer);
    const metadata = await authorizationServerMetadata(issuer);
    return metadata.client_id_metadata_document_supported ? { client_id: clientMetadataDocumentUrl(origin), issuer } : undefined;
  } catch {
    return undefined;
  }
}

// MCP 標準の OAuth（検出・PKCE・state 検証・トークン交換・更新）は AI SDK が行う。
// ここではその保存先（ユーザーと MCP サーバーの組ごと）と、クライアント登録の選び方を提供する。
export class StoredOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private tokensHidden = false;

  private constructor(
    private server: McpServer,
    private origin: string,
    private key: string,
    private data: Stored,
    private startsAuth: boolean,
    private cimd: OAuthClientInformation | undefined,
  ) {}

  // startsAuth: 認可を始めてよいか。「接続」ボタン（/api/mcp/connect）のときだけ true にする。
  // 状態確認やチャットで認可を始めると、接続中の別タブの state と PKCE を上書きしてしまうため
  static async load(server: McpServer, origin: string, user: string, startsAuth = false) {
    const key = keyOf(user, server.name);
    const data = (await getStore().get(key)) as Stored;
    const cimd = !server.client_id && !data.client ? await cimdClient(server, origin) : undefined;
    return new StoredOAuthProvider(server, origin, key, data, startsAuth, cimd);
  }

  // 変わった項目だけを書き込む（undefined の項目は消す）
  private async save(patch: Partial<Stored>) {
    Object.assign(this.data, patch);
    const entries = Object.entries(patch);
    const set = Object.fromEntries(entries.filter(([, v]) => v !== undefined));
    const removed = entries.filter(([, v]) => v === undefined).map(([k]) => k);
    if (Object.keys(set).length) await getStore().set(this.key, set, TTL_SECONDS);
    if (removed.length) await getStore().remove(this.key, removed);
  }

  get redirectUrl() {
    return `${this.origin}/api/mcp/callback`;
  }

  get clientMetadata() {
    return clientMetadata(this.origin, this.server.client_secret ? 'client_secret_basic' : 'none');
  }

  /** insufficient_scope で求められた、追加の認可が必要なスコープ */
  get stepUpScope() {
    return this.data.stepUpScope;
  }

  /** 追加の認可（step-up）を始めるために、手元のトークンを使わずに認可から始めさせる */
  hideTokens() {
    this.tokensHidden = true;
  }

  // コールバックでどのサーバーの認可かを判別できるよう、state の先頭にサーバー名を付ける
  state = () => `${this.server.name}.${randomUUID()}`;
  saveState = async (state: string) => {
    if (this.startsAuth) await this.save({ state });
  };
  storedState = () => this.data.state;

  // クライアント登録の優先順位（MCP 認可仕様）: 事前登録 → 登録済み → CIMD → 動的クライアント登録（SDK が行う）
  clientInformation = () => {
    if (this.server.client_id) {
      return { client_id: this.server.client_id, client_secret: this.server.client_secret, issuer: this.server.issuer };
    }
    return this.data.client ?? this.cimd;
  };
  saveClientInformation = (client: OAuthClientInformation) => this.save({ client });
  isClientInformationDynamicallyRegistered = () => !this.server.client_id && !!this.data.client;

  // トークンエンドポイントでのクライアント認証（RFC 6749 §2.3.1）。
  // SDK は認可サーバーのメタデータに token_endpoint_auth_methods_supported が無いと client_secret_post を選ぶが、
  // RFC 8414 §2 では省略時の既定は client_secret_basic なので、ここで選び直す
  addClientAuthentication = (
    headers: Headers,
    params: URLSearchParams,
    _url: string | URL,
    metadata?: { token_endpoint_auth_methods_supported?: string[] },
  ) => {
    const client = this.clientInformation();
    if (!client) return;
    // 公開クライアント（CIMD や動的登録）は client_id だけを送る（RFC 6749 §2.1）
    if (!client.client_secret) {
      params.set('client_id', client.client_id);
      return;
    }
    const methods = metadata?.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    if (!methods.includes('client_secret_basic') && methods.includes('client_secret_post')) {
      params.set('client_id', client.client_id);
      params.set('client_secret', client.client_secret);
      return;
    }
    // ID とシークレットはフォーム形式でエンコードしてから Basic にする（RFC 6749 §2.3.1、付録 B）
    const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    const credentials = Buffer.from(`${encode(client.client_id)}:${encode(client.client_secret)}`).toString('base64');
    headers.set('Authorization', `Basic ${credentials}`);
  };

  // 認可開始時に検出した認可サーバーを、コールバックでのトークン交換まで覚えておく
  authorizationServerInformation = () => this.data.authServer;
  saveAuthorizationServerInformation = (authServer: OAuthAuthorizationServerInformation) =>
    this.save({ authServer });

  tokens = () => (this.tokensHidden ? undefined : this.data.tokens);
  // ID トークンは使わないので保存しない。新しいトークンで追加の認可も済んだことになる
  saveTokens = ({ id_token: _, ...tokens }: OAuthTokens) =>
    this.save({ tokens, verifier: undefined, state: undefined, stepUpScope: undefined });

  saveCodeVerifier = async (verifier: string) => {
    if (this.startsAuth) await this.save({ verifier });
  };
  codeVerifier = () => this.data.verifier ?? '';

  // サーバー側ではリダイレクトできないので、URL を画面に返してユーザーに開いてもらう
  redirectToAuthorization = (url: URL) => {
    this.authorizationUrl = url;
  };

  invalidateCredentials = async (scope: 'all' | 'client' | 'tokens' | 'verifier') => {
    if (scope === 'all') await this.save({ client: undefined, tokens: undefined, verifier: undefined });
    else await this.save({ [scope]: undefined });
  };
}

/**
 * MCP サーバーとの通信。
 * - Next.js の中では fetch の Response が SDK の `instanceof Response` 判定をすり抜け、OAuth のエラー
 *   （invalid_grant など）が読めなくなるので、エラーのときだけ標準の Response に詰め直す（成功時はそのまま）
 * - 403 の insufficient_scope（MCP 認可仕様の Scope Challenge）なら、求められたスコープを知らせる
 */
export function createMcpFetch(onInsufficientScope?: (scope: string) => Promise<void>): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    if (res.ok) return res;
    const url = input instanceof Request ? input.url : String(input);
    if (res.status === 403 && onInsufficientScope) {
      const { error, scope } = extractWWWAuthenticateParams(res);
      if (error === 'insufficient_scope' && scope) {
        log.info('mcp_insufficient_scope', { url: url.split('?')[0], scope });
        await onInsufficientScope(scope);
      }
    }
    const body = await res.text();
    // トークンエンドポイントのエラー本文は error / error_description だけで、トークンは含まない
    if (url.includes('/token')) log.error('oauth_token_request_failed', { url: url.split('?')[0], status: res.status, body: body.slice(0, 300) });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

export const mcpFetch = createMcpFetch();

const mergeScopes = (...scopes: (string | undefined)[]) =>
  [...new Set(scopes.flatMap((s) => s?.split(/\s+/) ?? []).filter(Boolean))].join(' ');

export type McpUser = { id: string; idToken?: string };

/**
 * XAA で MCP サーバーのアクセストークンを得る（期限まではキャッシュを使う）。
 * 認可サーバーは MCP サーバーの Protected Resource Metadata で確かめる（resource が一致すること、認可サーバーが載っていること）。
 * insufficient_scope で求められたスコープがあれば足して交換し直し、拒否されたら元のスコープに戻る。
 */
async function xaaToken(server: McpServer, user: McpUser): Promise<string> {
  const key = keyOf(user.id, server.name);
  const data = (await getStore().get(key)) as Stored;
  const cached = data.tokens;
  const valid = !!cached && (cached.expires_at ?? 0) - XAA_MARGIN_SECONDS > Date.now() / 1000;
  if (valid && !data.stepUpScope) return cached.access_token;
  if (!user.idToken) throw new Error('ログインし直してください（ID トークンの期限切れ）');

  const { resource } = await resourceInfo(server.url);
  const issuer = await authorizationServerFor(server.url, server.issuer);
  const exchange = async (scope: string) => {
    try {
      const issued = await exchangeIdToken(user.idToken!, { issuer, scope, ...(server.xaa_resource ? { resource } : {}) });
      const tokens = { access_token: issued.access_token!, token_type: 'Bearer', expires_at: issued.expires_at };
      await getStore().set(key, { tokens }, TTL_SECONDS);
      return tokens.access_token;
    } catch (error) {
      // Okta のエラー（invalid_grant、invalid_target など）をそのまま残す。トークンは含まない
      log.error('xaa_exchange_failed', { server: server.name, user: user.id, scope, ...errorFields(error) });
      throw error;
    }
  };

  if (data.stepUpScope) {
    const requested = mergeScopes(server.scope, data.stepUpScope);
    await getStore().remove(key, ['stepUpScope']);
    try {
      return await exchange(requested);
    } catch {
      log.warn('xaa_step_up_denied', { server: server.name, user: user.id, scope: requested });
      if (valid) return cached.access_token;
    }
  }
  return exchange(server.scope ?? '');
}

class AuthorizationRequired extends Error {
  constructor(readonly url: URL) {
    super('authorization required');
  }
}

/** MCP サーバーに接続する。oauth は保存したトークン（無ければ認可を始める）、xaa は交換したトークンを使う */
async function connect(server: McpServer, origin: string, user: McpUser, startsAuth: boolean) {
  const key = keyOf(user.id, server.name);
  const fetch = createMcpFetch((scope) => getStore().set(key, { stepUpScope: scope }, TTL_SECONDS));

  if (server.auth === 'xaa') {
    const token = await xaaToken(server, user);
    try {
      const client = await createMCPClient({
        transport: { type: 'http', url: server.url, headers: { Authorization: `Bearer ${token}` }, fetch },
      });
      return { client, stepUp: false };
    } catch (error) {
      // 拒否されたトークンは捨て、次回は交換し直す
      await getStore().remove(key, ['tokens']);
      throw error;
    }
  }

  const authProvider = await StoredOAuthProvider.load(server, origin, user.id, startsAuth);
  // 追加の権限が必要なときは、「接続」で、求められたスコープを付けて認可し直す（step-up）
  if (startsAuth && authProvider.stepUpScope) {
    authProvider.hideTokens();
    await auth(authProvider, { serverUrl: server.url, scope: authProvider.stepUpScope, fetchFn: mcpFetch });
    if (authProvider.authorizationUrl) throw new AuthorizationRequired(authProvider.authorizationUrl);
  }
  try {
    const client = await createMCPClient({ transport: { type: 'http', url: server.url, authProvider, fetch } });
    return { client, stepUp: !!authProvider.stepUpScope };
  } catch (error) {
    if (error instanceof UnauthorizedError && authProvider.authorizationUrl) throw new AuthorizationRequired(authProvider.authorizationUrl);
    throw error;
  }
}

export type ServerStatus = {
  name: string;
  tools?: number;
  /** 認可を始めた URL（接続の操作が必要なとき） */
  authorizeUrl?: string;
  /** 接続済みだが、追加の権限（step-up）が必要 */
  stepUp?: boolean;
  error?: string;
};

// MCP サーバー（name 指定時はそのサーバーだけで、認可も始める）に接続し、ツールを `<サーバー名>__<ツール名>` でまとめる。
// 未接続の oauth サーバーでは SDK が認可を始め、その URL を authorizeUrl に入れて返す
export async function connectAll(origin: string, user: McpUser, name?: string) {
  const tools: ToolSet = {};
  const clients: MCPClient[] = [];
  const statuses: ServerStatus[] = [];

  for (const server of mcpServers().filter((s) => !name || s.name === name)) {
    try {
      const { client, stepUp } = await connect(server, origin, user, name !== undefined);
      clients.push(client);
      const serverTools = await client.tools();
      for (const [toolName, t] of Object.entries(serverTools)) tools[`${server.name}__${toolName}`] = t;
      statuses.push({ name: server.name, tools: Object.keys(serverTools).length, ...(stepUp ? { stepUp } : {}) });
    } catch (error) {
      if (error instanceof AuthorizationRequired) {
        statuses.push({ name: server.name, authorizeUrl: error.url.toString() });
        continue;
      }
      if (!(error instanceof UnauthorizedError)) log.warn('mcp_connect_failed', { server: server.name, ...errorFields(error) });
      statuses.push({ name: server.name, error: (error as Error).message });
    }
  }
  return { tools, statuses, close: () => Promise.all(clients.map((c) => c.close())) };
}

// 未接続、または追加の権限が必要な MCP サーバーには「接続ツール」（<name>__connect）を用意する。
// モデルが必要と判断して呼ぶと、画面がそのツール呼び出しを見て接続ボタンを出す
export function connectTools(statuses: ServerStatus[]): ToolSet {
  const tools: ToolSet = {};
  for (const s of statuses.filter((s) => s.authorizeUrl || s.stepUp)) {
    const description = mcpServers().find((m) => m.name === s.name)?.description ?? s.name;
    const purpose = s.stepUp
      ? `Grant the "${s.name}" MCP server (${description}) the additional permission it asked for. Call this when one of its tools failed because of insufficient permission.`
      : `Connect the "${s.name}" MCP server (${description}) so that its tools become available. Call this when the user's request needs it.`;
    tools[`${s.name}__connect`] = tool({
      description: purpose,
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: async () =>
        `A button labeled "${labelOf(s.name)} に接続" is now shown to the user. Ask them to press it and then send the request again.`,
    });
  }
  return tools;
}

// 画面に返す接続状態（認可 URL は返さない。接続は /api/mcp/connect から始める）
export const publicStatuses = (statuses: ServerStatus[]) =>
  statuses.map(({ authorizeUrl, ...s }) => ({ ...s, label: labelOf(s.name), needsAuth: !!authorizeUrl }));

/** ログアウト時: このユーザーの MCP のトークンなどをすべて消す */
export async function deleteUserData(user: string) {
  await Promise.all(mcpServers().map((s) => getStore().delete(keyOf(user, s.name))));
}
