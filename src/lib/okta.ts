import { Issuer, type BaseClient, type ClientMetadata } from 'openid-client';
import { authorizationServerMetadata } from './discovery';
import { log } from './log';

// Okta との通信（ログインのトークン更新、ログアウト、XAA の交換）。どれも openid-client の標準機能で行う。
// クライアント認証は、OKTA_AI_AGENT_PRIVATE_KEY（AI エージェントの秘密鍵）があれば private_key_jwt、無ければクライアントシークレット。
// Okta では 1 つのクライアントの認証方式は 1 つなので、ログイン（next-auth）も同じ設定を使う。

// private_key_jwt の鍵（openid-client の型に合わせる）
type Jwks = NonNullable<ConstructorParameters<typeof BaseClient>[1]>;
type JWK = Jwks['keys'][number];

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const ID_JAG = 'urn:ietf:params:oauth:token-type:id-jag';
const ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
const ID_JAG_PROFILE = 'urn:ietf:params:oauth:grant-profile:id-jag';

function privateKey(): JWK | undefined {
  const raw = process.env.OKTA_AI_AGENT_PRIVATE_KEY;
  return raw ? (JSON.parse(raw) as JWK) : undefined;
}

/** クライアントの登録情報（client_id と認証方式）と、private_key_jwt の鍵 */
export function clientCredentials(clientId: string): { client: ClientMetadata; jwks?: Jwks } {
  const key = privateKey();
  if (key) {
    return {
      client: {
        client_id: clientId,
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_signing_alg: key.alg ?? 'RS256',
      },
      jwks: { keys: [key] },
    };
  }
  return {
    client: {
      client_id: clientId,
      client_secret: process.env.OKTA_CLIENT_SECRET,
      token_endpoint_auth_method: 'client_secret_basic',
    },
  };
}

const issuers = new Map<string, Promise<Issuer<BaseClient>>>();

/** 認可サーバーのメタデータを取得し、その認可サーバー用のクライアントを作る */
async function clientFor(issuer: string, clientId: string): Promise<BaseClient> {
  let discovered = issuers.get(issuer);
  if (!discovered) {
    discovered = Issuer.discover(issuer);
    discovered.catch(() => issuers.delete(issuer)); // 失敗したら次回もう一度取得する
    issuers.set(issuer, discovered);
  }
  const { client, jwks } = clientCredentials(clientId);
  return new (await discovered).Client(client, jwks);
}

/**
 * private_key_jwt のクライアントアサーションの aud は、トークンエンドポイントの URL にする。
 * RFC 7523 §3 は認可サーバーを示す値なら良く、トークンエンドポイントの URL も使える（MAY）とし、Okta はこの形を求める
 * （openid-client の既定は issuer）。クライアントシークレットのときは使われない
 */
export const assertionAudience = (client: BaseClient) => ({
  clientAssertionPayload: { aud: client.issuer.metadata.token_endpoint },
});

/** テスト用: 取得済みのメタデータを消す */
export function clearIssuerCache() {
  issuers.clear();
}

/** ログインのトークンを更新する（ID トークンは 1 時間で切れるため） */
export async function refreshLogin(refreshToken: string) {
  const client = await clientFor(process.env.OKTA_ISSUER!, process.env.OKTA_CLIENT_ID!);
  return client.refresh(refreshToken, assertionAudience(client));
}

/** OIDC RP-Initiated Logout: Okta のセッションも終わらせる URL */
export async function logoutUrl(idToken: string | undefined, postLogoutRedirectUri: string) {
  const client = await clientFor(process.env.OKTA_ISSUER!, process.env.OKTA_CLIENT_ID!);
  return client.endSessionUrl({
    ...(idToken ? { id_token_hint: idToken } : {}),
    post_logout_redirect_uri: postLogoutRedirectUri,
  });
}

export type XaaRequest = {
  /** MCP サーバーの認可サーバー（Protected Resource Metadata の authorization_servers） */
  issuer: string;
  /**
   * MCP サーバーの識別子（Protected Resource Metadata の resource）。仕様上 OPTIONAL で、付けるときは MCP サーバーの識別子にする。
   * Okta は AI エージェントの Managed connection の構成によって、付けると invalid_target を返すので、既定では付けない
   */
  resource?: string;
  scope: string;
};

/**
 * XAA（Cross App Access。IETF の Identity Assertion JWT Authorization Grant と MCP の Enterprise-Managed Authorization）:
 * ユーザーの ID トークン → ID-JAG（Okta の Org 認可サーバー、RFC 8693 Token Exchange）→
 * アクセストークン（MCP サーバーの認可サーバー、RFC 7523 JWT Bearer）。交換はどちらも AI エージェントとして行う。
 */
export async function exchangeIdToken(idToken: string, { issuer, resource, scope }: XaaRequest) {
  const agentId = process.env.OKTA_AI_AGENT_ID || process.env.OKTA_CLIENT_ID!;

  // 認可サーバーが ID-JAG を受け付けると宣言していない場合は、記録だけ残して続ける（宣言しない実装もあるため）
  const metadata = (await authorizationServerMetadata(issuer)) as { authorization_grant_profiles_supported?: string[] };
  const profiles = metadata.authorization_grant_profiles_supported;
  if (!profiles?.includes(ID_JAG_PROFILE)) log.warn('xaa_profile_not_advertised', { issuer });

  const org = await clientFor(process.env.OKTA_ISSUER!, agentId);
  const idJag = await org.grant(
    {
      grant_type: TOKEN_EXCHANGE,
      requested_token_type: ID_JAG,
      subject_token: idToken,
      subject_token_type: ID_TOKEN,
      audience: issuer,
      ...(resource ? { resource } : {}),
      ...(scope ? { scope } : {}),
    },
    assertionAudience(org),
  );
  // 応答が ID-JAG であること（issued_token_type）と、そのまま使うトークンではないこと（token_type: N_A）を確かめる
  if (idJag.issued_token_type !== ID_JAG || idJag.token_type?.toLowerCase() !== 'n_a' || !idJag.access_token) {
    throw new Error(`Unexpected token exchange response: issued_token_type=${idJag.issued_token_type}, token_type=${idJag.token_type}`);
  }

  const resourceServer = await clientFor(issuer, agentId);
  return resourceServer.grant({ grant_type: JWT_BEARER, assertion: idJag.access_token }, assertionAudience(resourceServer));
}
