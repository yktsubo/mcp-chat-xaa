import type { NextConfig } from 'next';

// agentRules: next dev が AGENTS.md / CLAUDE.md を自動生成しないようにする
const nextConfig: NextConfig = { agentRules: false };

export default nextConfig;
