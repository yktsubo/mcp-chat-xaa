# MCP Chat

Okta でログインし、標準の MCP（Model Context Protocol）で **Okta Agent Gateway** などの MCP サーバーに接続して、そのツールを LLM（Claude または Azure OpenAI）から使うチャットアプリです。Okta の **Cross App Access（XAA）** に対応しています。Next.js 1 つで構成し、Vercel だけで動きます。

```
ブラウザ ──(ログイン: Okta OIDC)──▶ Next.js（Vercel）──▶ Claude / Azure OpenAI
                                       │
                                       ├──(MCP + XAA)───▶ Okta Agent Gateway ──▶ Atlassian などの SaaS
                                       ├──(MCP + OAuth)─▶ そのほかの MCP サーバー（Notion など）
                                       └── Upstash Redis（MCP のトークンの保存先、回数制限）
```

## 動き

1. **ログイン**: アプリには Okta の OIDC（認可コード + PKCE、state、nonce）でログインする。ログインのセッションは暗号化 Cookie（next-auth）に入る
2. **MCP サーバーへの接続**は、サーバーごとに 2 通り
   - **XAA**（`"auth": "xaa"`。Okta Agent Gateway 向け）: ログインの ID トークンを、Okta で ID-JAG に交換し、さらに MCP サーバーの認可サーバーでアクセストークンに交換する。ユーザーの操作は不要で、誰がどのサーバーを使えるかは Okta の管理者が決める
   - **OAuth**（既定）: 未接続のサーバーは、モデルが必要と判断したときに応答に「◯◯ に接続」ボタンが出る。押すと別タブで、MCP の認可仕様どおりに接続する（認可コード + PKCE）
3. **ツールの利用**: MCP のトークンは、ユーザーと MCP サーバーの組ごとに Redis に保存し、ブラウザや LLM には渡さない。SaaS 側のトークンは Agent Gateway が持つ
4. **追加の権限**: ツールが `403 insufficient_scope` で拒否されたら、求められたスコープを記録する。XAA のサーバーはスコープを足して自動で交換し直し、OAuth のサーバーは「接続」ボタンから、そのスコープで認可し直す
5. **ログアウト**: そのユーザーの MCP のトークンを削除し、Okta のセッションも終了する（OIDC RP-Initiated Logout）

## 準拠している仕様

| 仕様 | このアプリでの扱い |
|---|---|
| MCP Authorization（2025-11-25） | Protected Resource Metadata（RFC 9728）による認可サーバーの検出、認可サーバーのメタデータ（RFC 8414 / OIDC Discovery）、PKCE（S256）、`resource` パラメーター（RFC 8707）、state、`iss` の検証（RFC 9207）、スコープの選び方、`insufficient_scope` での追加の認可、クライアント登録の優先順位（事前登録 → Client ID Metadata Document → 動的登録） |
| MCP Enterprise-Managed Authorization / IETF Identity Assertion JWT Authorization Grant（ID-JAG） | Token Exchange（RFC 8693）で ID-JAG を取得（`audience`、`scope`。省略可能な `resource` は設定で付ける）、応答の種類の確認、JWT Bearer（RFC 7523）でアクセストークンを取得、認可サーバーは Protected Resource Metadata で確認、private_key_jwt の `aud` はトークンエンドポイント |
| OpenID Connect / OAuth 2.1 | ログインは認可コード + PKCE + state + nonce、ID トークンの検証、リフレッシュトークンでの更新、RP-Initiated Logout |

## 必要なもの

- Okta（Okta for AI Agents と Agent Gateway が使える組織）
- Vercel のアカウント
- LLM: Anthropic の API キー、または Azure OpenAI のリソースとデプロイ
- ローカルで動かす場合: Node.js 20.9 以上

## 構築手順

### 1. Okta: Agent Gateway の仮想 MCP サーバー

1. **Applications and Resources → MCP Servers** で、使いたい SaaS の MCP サーバー（例: Atlassian `https://mcp.atlassian.com/v1/mcp`）を登録し、公開するツールを選ぶ
2. **Agent Gateway** で仮想 MCP サーバー（vMCP）を作り、手順 1 の MCP サーバーを追加する。vMCP の URL（例: `https://<org>.gateway.okta.com/mcp/servers/<name>`）を控える
3. vMCP の Protected Resource Metadata の `authorization_servers` にある認可サーバー（例: `https://<org>.okta.com/oauth2/<id>`）を確認する

   ```
   https://<org>.gateway.okta.com/.well-known/oauth-protected-resource/mcp/servers/<name>
   ```

### 2. Okta: AI エージェントと OIDC アプリ

AI エージェントに結び付いた OIDC アプリ（Web アプリ）を使います。このアプリで、アプリへのログインと MCP サーバーへの接続の両方を行います。

| 項目 | 値 |
|---|---|
| Grant type | Authorization Code、Refresh Token |
| クライアント認証 | クライアントシークレット、または AI エージェントの鍵（private_key_jwt）。Okta では 1 つのクライアントの認証方式は 1 つなので、ログインと XAA で同じ方式を使う |
| Sign-in redirect URIs | `https://<Vercel のドメイン>/api/auth/callback/okta`（ログイン用）<br>`https://<Vercel のドメイン>/api/mcp/callback`（OAuth の MCP サーバー用） |
| Sign-out redirect URIs | `https://<Vercel のドメイン>/` |
| Assignments | アプリを使うユーザーまたはグループ |

ローカルで動かす場合は、`http://localhost:3000/...` のリダイレクト URI も追加します。

### 3. Okta: XAA の設定（Agent Gateway を XAA で使う場合）

1. 手順 1-3 の認可サーバー（**Security → API → Authorization Servers**）で
   - **Scopes**: vMCP 用のスコープ（例: `gateway:connect`）を用意する（ID-JAG の要求では `openid` は使えない）
   - **Access Policies**: AI エージェントに、Grant type **JWT Bearer** と手順のスコープを許可するルールを作る
2. **Directory → AI Agents →（エージェント）→ Managed connections** で、手順 1-3 の認可サーバーへの接続（Authorization Server）を、手順のスコープで追加する

XAA を使わず、Agent Gateway に OAuth（「接続」ボタン）でつなぐ場合は、手順 1-3 の認可サーバーのアクセスポリシーで、このアプリに Grant type **Authorization Code** を許可します。

### 4. Vercel: プロジェクトと Redis

1. このリポジトリを Vercel にインポートする（Framework Preset: Next.js、Root Directory はそのまま）
2. プロジェクトの **Storage → Create Database → Upstash for Redis** で Redis を作り（無料プランで可。リージョンは関数に近い場所）、**Connect Project** でこのプロジェクトにつなぐ。`KV_REST_API_URL` と `KV_REST_API_TOKEN` が自動で設定される
3. **Settings → Environment Variables** に次の環境変数を設定する

| 変数 | 必須 | 内容 |
|---|---|---|
| `NEXTAUTH_URL` | ○ | アプリの URL（例: `https://xxx.vercel.app`） |
| `NEXTAUTH_SECRET` | ○ | ログインのセッションの暗号鍵（`openssl rand -base64 32`） |
| `OKTA_ISSUER` | ○ | ログインに使う Okta の issuer（Org 認可サーバー。例: `https://<org>.okta.com`） |
| `OKTA_CLIENT_ID` | ○ | 手順 2 の OIDC アプリ |
| `OKTA_CLIENT_SECRET` / `OKTA_AI_AGENT_PRIVATE_KEY` | どちらか | クライアントシークレット、または AI エージェントの秘密鍵（JWK を 1 行の JSON で。設定すると private_key_jwt を使う） |
| `OKTA_AI_AGENT_ID` | | XAA の交換を行う AI エージェントの ID（省略時は `OKTA_CLIENT_ID`） |
| `MCP_SERVERS` | ○ | MCP サーバーの一覧（下記） |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | ○ | 手順 4-2 で自動設定される |
| `CHAT_RATE_LIMIT_PER_MINUTE` | | チャットの回数制限（ユーザーごと、1 分あたり。既定 10） |
| `SYSTEM_PROMPT` | | システムプロンプト。未設定なら汎用のアシスタント |
| `ANTHROPIC_API_KEY` | Claude を使う場合 | Anthropic の API キー |
| `ANTHROPIC_MODEL` | | Claude のモデル。未設定なら `claude-haiku-5-5`（例: `claude-sonnet-5-5`） |
| `ANTHROPIC_WORKSPACE_ID` | | ワークスペースに紐づかない組織キーの場合だけ |
| `AZURE_API_KEY` / `AZURE_RESOURCE_NAME` / `AZURE_OPENAI_DEPLOYMENT` | Azure OpenAI を使う場合 | `AZURE_OPENAI_DEPLOYMENT` を設定すると Azure OpenAI に切り替わる。モデルはデプロイで決まる |

4. **Deployments → Redeploy** で再デプロイする（環境変数を変えたときも同じ）
5. 割り当てられたドメインで、手順 2 のリダイレクト URI を Okta に登録する

### MCP_SERVERS の書き方

```json
[
  {
    "name": "gateway",
    "label": "Okta Agent Gateway",
    "url": "https://<org>.gateway.okta.com/mcp/servers/<name>",
    "description": "Jira と Confluence",
    "auth": "xaa",
    "scope": "gateway:connect"
  },
  {
    "name": "notion",
    "label": "Notion",
    "url": "https://mcp.notion.com/mcp",
    "description": "Notion のページとデータベース"
  }
]
```

| キー | 内容 |
|---|---|
| `name` | ID。英数字と `-`（`.` は使わない）。ツール名の接頭辞と保存先の鍵に使うので、変えると接続し直しになる |
| `label` | 画面に出す名前（省略時は `name`） |
| `url` | MCP サーバーの URL |
| `description` | 何ができるサーバーか。未接続のとき、モデルが接続を求めるかどうかの判断に使う |
| `auth` | `xaa`（XAA で自動接続）または `oauth`（既定。「接続」ボタンで接続） |
| `scope` | XAA で要求するスコープ（手順 3） |
| `xaa_resource` | `true` にすると、XAA の ID-JAG の要求に `resource`（MCP サーバーの識別子）を付ける。仕様上は省略可能で、Okta は AI エージェントの Managed connection の構成によっては付けると `invalid_target` を返すため、既定では付けない |
| `issuer` | 使う認可サーバー。省略時は Protected Resource Metadata の先頭。指定した場合は、そこに載っていることを確かめてから使う |
| `client_id` / `client_secret` | OAuth で使う事前登録したクライアント（Agent Gateway に OAuth でつなぐ場合は手順 2 のアプリ。Okta は匿名の動的クライアント登録を受け付けない）。省略すると、認可サーバーが対応していれば Client ID Metadata Document（`https://<ドメイン>/oauth/client-metadata.json`）、そうでなければ動的クライアント登録を使う |

### 5. 動作確認

1. アプリの URL を開き、「ログイン」から Okta でログインする。ヘッダーにユーザー名が出る
2. 右（スマホでは上）の「MCP サーバー」で、XAA のサーバーは「✅ N ツール」、OAuth のサーバーは「未接続」になる
3. 「Jira の課題を探して」のように送ると、ツールが実行される（吹き出し内と、右の「最近のツール実行」に状態が出る）
4. OAuth のサーバーが必要な依頼をすると、応答に「◯◯ に接続」ボタンが出る。押すと別タブで接続が終わり、タブが閉じる
5. 「ログアウト」で Okta のセッションも終了し、アプリに戻る

SaaS のアカウントを初めて使う場合、Agent Gateway が「Connection required」のリンクを返します。リンクを開いて SaaS を接続してから、もう一度依頼してください。

## ログ（トラブル時）

サーバーのログは 1 行の JSON で出力します。Vercel の **Logs** 画面で、レベル（error / warning / info）や `event` の値で絞り込めます。トークン、シークレット、認可コードはログに出しません。

| event | レベル | 内容 |
|---|---|---|
| `chat_failed` | error | 応答の生成に失敗した（LLM の API エラーなど）。スタックトレース付き |
| `tool_failed` | warning | ツールの実行に失敗した |
| `rate_limited` | warning | チャットの回数制限を超えた |
| `mcp_connect_failed` | warning | MCP サーバーに接続できなかった（未接続による 401 は除く） |
| `mcp_insufficient_scope` | info | MCP サーバーが追加の権限（スコープ）を求めた |
| `xaa_exchange_failed` | error | XAA の交換を Okta が拒否した（`invalid_target`、`access_denied` など。Okta の設定を確認） |
| `xaa_step_up_denied` | warning | XAA で追加のスコープを Okta が許可しなかった（元のスコープで続ける） |
| `xaa_profile_not_advertised` | warning | MCP サーバーの認可サーバーが ID-JAG への対応をメタデータで宣言していない（交換は試みる） |
| `oauth_token_request_failed` | error | 認可サーバーがトークンの発行を拒否した。認可サーバーが返したエラー（`invalid_grant` など）付き |
| `mcp_oauth_callback_failed` | error | OAuth の接続の最後（認可コードとトークンの交換）に失敗した |
| `mcp_oauth_callback_rejected` | warning | OAuth の接続のコールバックを受け付けなかった（`access_denied`: ユーザーが拒否、`no_code` / `unknown_state` / `no_session`: 不正または期限切れ） |
| `mcp_connected` | info | OAuth で MCP サーバーに接続した |
| `login_refresh_failed` | warning | ログインのトークンの更新を Okta が拒否した（再ログインが必要） |
| `logout` / `okta_logout_url_failed` | info / warning | ログアウトした / Okta のログアウト URL を作れなかった（アプリからはログアウトする） |
| `request_error` | error | 上記以外の想定外のサーバーエラー（Next.js の `onRequestError`）。スタックトレース付き |

画面のエラー表示は要約だけです。詳しい原因はログで確認してください。

### XAA のエラーと対処

| Okta が返すエラー | 主な原因と対処 |
|---|---|
| `invalid_target`（`Token Exchange requests must include a valid audience of the authorization server.` / `The token request contains an invalid target.`） | AI エージェントの接続（Managed connections / Resource connections）に、vMCP の認可サーバーへの接続が無いか、有効でない。Okta は、ID-JAG を発行するかどうかをこの接続で判断するため、アプリから送るパラメーターを変えても通らない。手順 3 を確認する |
| `invalid_request`（`'subject_token' is invalid`） | ID トークンが、交換するクライアントのものではない（`OKTA_CLIENT_ID` を変えた直後など）。ログインし直す |
| `invalid_client` | クライアント認証の方式が Okta のアプリの設定と合っていない（クライアントシークレットと private_key_jwt）、または鍵が登録されていない |
| `invalid_scope` | 要求したスコープが、AI エージェントの接続や認可サーバーのアクセスポリシーで許可されていない（ID-JAG の要求では `openid` は使えない） |

## ローカルで動かす

```bash
npm install
cp .env.example .env.local      # 値を入れる
vercel env pull .env.local      # （任意）Vercel の環境変数と Redis の接続情報を取り込む
npm run dev                     # http://localhost:3000
```

- Redis の接続情報が無いときは、ローカル開発に限りメモリに保存し、回数制限もしません（再起動すると接続し直しになります）
- ローカル（http）では Client ID Metadata Document は使えないため、動的クライアント登録を使います

## テスト

```bash
npm test                 # テスト
npm run test:coverage    # カバレッジ（coverage/index.html にも出力）
npm run typecheck        # 型チェック
```

`src/conformance` は、標準プロトコルへの準拠テストです。テスト名に根拠となる仕様の箇所（例: `[MCP Auth / RFC 8707 §2]`）を書いています。仕様どおりに応答する偽の認可サーバー・MCP サーバー・Okta（`nock`）を相手に、アプリの API ルートと `@ai-sdk/mcp`・`openid-client`・next-auth を実際に動かし、送られた HTTP リクエストを仕様の要件と照合します。仕様上拒否すべき場合（state・iss・nonce・aud の不一致、PKCE 非対応、メタデータの不一致など）の失敗ケースも含みます。

| ファイル | 対象 |
|---|---|
| `src/conformance/mcp-authorization.test.ts` | MCP Authorization（2025-11-25）、RFC 9728 / 8414 / 8707 / 7636 / 9207 / 6750 / 7591 / 6749、Client ID Metadata Document |
| `src/conformance/xaa.test.ts` | IETF ID-JAG、MCP Enterprise-Managed Authorization、RFC 8693 / 7523 |
| `src/conformance/oidc.test.ts` | OpenID Connect Core（認可リクエスト、ID トークンの検証）、RFC 6749 §6（更新）、RP-Initiated Logout |

カバレッジの対象は、このアプリのコード（`src/lib`、`src/app`、`src/components/Header.tsx`、`src/instrumentation.ts`）です。`src/components/ui` と `src/components/ai-elements` は shadcn/ui と AI Elements の CLI が生成した部品で、ライブラリとして対象から外しています。

## 構成

| パス | 内容 |
|---|---|
| `src/app/page.tsx`, `src/app/Chat.tsx`, `src/components/Header.tsx` | 画面（ログイン、チャット、ヘッダー） |
| `src/app/api/chat/route.ts` | チャット API（LLM の呼び出しとツール実行、ストリーミング、回数制限） |
| `src/app/api/mcp/route.ts` | MCP サーバーの接続状態 |
| `src/app/api/mcp/connect/route.ts`, `src/app/api/mcp/callback/route.ts` | OAuth の MCP サーバーへの接続（認可の開始とコールバック） |
| `src/app/oauth/client-metadata.json/route.ts` | Client ID Metadata Document |
| `src/app/api/auth/[...nextauth]/route.ts`, `src/app/api/logout/route.ts`, `src/lib/auth.ts` | ログインとログアウト |
| `src/lib/mcp.ts` | MCP クライアント、OAuth の保存先、XAA の接続、追加の権限 |
| `src/lib/okta.ts` | Okta との通信（ログインの更新、ログアウト、XAA の交換） |
| `src/lib/discovery.ts` | Protected Resource Metadata と認可サーバーのメタデータ |
| `src/lib/store.ts`, `src/lib/ratelimit.ts` | 保存先（Upstash Redis。ローカル開発ではメモリ）と回数制限 |
| `src/lib/log.ts`, `src/instrumentation.ts` | ログ |

使っている主なライブラリ:

| 役割 | ライブラリ |
|---|---|
| アプリへのログイン | `next-auth` |
| Okta との通信（ログインの更新、ログアウト、XAA の交換） | `openid-client`（OpenID Certified） |
| MCP クライアントと MCP 標準の OAuth | `@ai-sdk/mcp` |
| メタデータの取得、`WWW-Authenticate` の解析 | `@modelcontextprotocol/sdk`（MCP 公式 SDK） |
| LLM の呼び出しとツール実行 | `ai`（Vercel AI SDK）、`@ai-sdk/anthropic`、`@ai-sdk/azure` |
| チャット画面 | `@ai-sdk/react`（`useChat`）、AI Elements（shadcn/ui） |
| Markdown 表示 | Streamdown。画像の読み込みと生の HTML は無効、リンクは http(s) のみで開く前に確認する |
| 保存先、回数制限 | `@upstash/redis`、`@upstash/ratelimit` |

## 注意事項

- 会話の履歴はブラウザのメモリだけに保持します（再読み込みで消えます）
- MCP のトークンは最後の利用から 30 日で期限が切れ、接続し直しになります。ログアウトするとすぐに削除します（認可サーバー側での失効は行いません）
- Agent Gateway が返す「アカウント接続」のリンクは、ツールの結果としてそのままモデルに渡ります
- LLM の応答とツールの結果は、外部の MCP サーバーの内容に影響されます。重要な操作を行うツールは、Okta 側で公開するツールやスコープを絞ってください
- MCP の `_meta` による Enterprise-Managed Authorization 拡張への対応の宣言は行っていません（`@ai-sdk/mcp` にリクエストごとに付ける手段がないため）
