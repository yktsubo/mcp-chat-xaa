import { createAnthropic } from '@ai-sdk/anthropic';
import { azure } from '@ai-sdk/azure';
import { convertToModelMessages, isStepCount, streamText, type UIMessage } from 'ai';
import type { NextRequest } from 'next/server';
import { currentUser } from '@/lib/auth';
import { errorFields, log } from '@/lib/log';
import { connectAll, connectTools } from '@/lib/mcp';
import { checkChatLimit } from '@/lib/ratelimit';

export const maxDuration = 300;

// AZURE_OPENAI_DEPLOYMENT があれば Azure OpenAI（AZURE_API_KEY / AZURE_RESOURCE_NAME）、なければ Claude。
// Claude のモデルは ANTHROPIC_MODEL（既定は Claude Haiku 5.5）
const model = () => {
  if (process.env.AZURE_OPENAI_DEPLOYMENT) return azure(process.env.AZURE_OPENAI_DEPLOYMENT);
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID; // ワークスペースに紐づかない組織キーの場合だけ必要
  const anthropic = createAnthropic(workspace ? { headers: { 'anthropic-workspace-id': workspace } } : {});
  return anthropic(process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5');
};

// useChat（@ai-sdk/react）から呼ばれ、応答とツール実行の途中経過をストリーミングで返す
export async function POST(req: NextRequest) {
  const current = await currentUser();
  if (!current) return Response.json({ error: 'ログインしてください' }, { status: 401 });
  const user = current.id;

  // 回数制限を超えたら、標準どおり 429 と Retry-After を返す
  const limit = await checkChatLimit(user);
  if (!limit.success) {
    log.warn('rate_limited', { user });
    return Response.json(
      { error: `回数の上限に達しました。${limit.retryAfterSeconds} 秒後にもう一度お試しください。` },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  const { messages } = (await req.json()) as { messages: UIMessage[] };
  const mcp = await connectAll(new URL(req.url).origin, current);
  // 未接続の MCP サーバーには接続ツールを渡す。呼ばれると画面に接続ボタンが出る（Chat.tsx）
  const tools = { ...mcp.tools, ...connectTools(mcp.statuses) };

  const result = streamText({
    model: model(),
    instructions: process.env.SYSTEM_PROMPT || 'You are a helpful assistant. Use the MCP tools when useful.',
    messages: await convertToModelMessages(messages, { tools }),
    tools,
    stopWhen: isStepCount(10),
    // 失敗したツール実行は、ログに残す（入力や結果の中身は出さない）
    onToolExecutionEnd: ({ toolCall, toolOutput }) => {
      if (toolOutput.type === 'tool-error') log.warn('tool_failed', { user, tool: toolCall.toolName, ...errorFields(toolOutput.error) });
    },
    // ストリームが終わったら（中断・エラーを含む）MCP の接続を閉じる
    onEnd: () => void mcp.close(),
    onAbort: () => void mcp.close(),
    onError: ({ error }) => {
      log.error('chat_failed', { user, ...errorFields(error, true) });
      void mcp.close();
    },
  });
  // 画面にはエラーの要約だけを返す（詳細はサーバーのログ）
  return result.toUIMessageStreamResponse({
    onError: (error) => (error instanceof Error ? error.message : 'エラーが発生しました'),
  });
}
