import { createApp } from './app'
import type { Env } from './app'

// Cloudflare Workers 엔트리 (주 배포 경로) — 시크릿은 wrangler secret put ANTHROPIC_API_KEY
const app = createApp((c) => c.env as Env)

export default app
