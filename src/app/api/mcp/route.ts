import type { NextRequest } from 'next/server';
import { currentUser } from '@/lib/auth';
import { connectAll, publicStatuses } from '@/lib/mcp';

// MCP サーバーごとの接続状態（チャット画面の表示後に読み込む）
export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'ログインしてください' }, { status: 401 });

  const mcp = await connectAll(new URL(req.url).origin, user);
  await mcp.close();
  return Response.json({ statuses: publicStatuses(mcp.statuses) });
}
