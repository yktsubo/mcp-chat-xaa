import { NextResponse, type NextRequest } from 'next/server';
import { currentUser } from '@/lib/auth';
import { connectAll } from '@/lib/mcp';

// 「接続」: クリックした時点で MCP の認可を始め（state と PKCE をここで作る）、認可サーバーへリダイレクトする
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const user = await currentUser();
  if (!user) return new Response('ログインしてください', { status: 401 });

  const mcp = await connectAll(url.origin, user, url.searchParams.get('server') ?? '');
  await mcp.close();
  return NextResponse.redirect(mcp.statuses[0]?.authorizeUrl ?? new URL('/', url.origin), 303);
}
