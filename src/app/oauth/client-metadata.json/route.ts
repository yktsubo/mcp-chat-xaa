import type { NextRequest } from 'next/server';
import { clientMetadata, clientMetadataDocumentUrl } from '@/lib/mcp';

// CIMD（OAuth Client ID Metadata Document）: この URL がそのまま client_id になり、
// 認可サーバーがここを取得してリダイレクト URI などを確かめる（事前登録の無い MCP サーバー向け）
export function GET(req: NextRequest) {
  const origin = new URL(req.url).origin;
  return Response.json(
    { client_id: clientMetadataDocumentUrl(origin), ...clientMetadata(origin) },
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}
