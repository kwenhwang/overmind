import { serve } from '@hono/node-server'
import { createApp } from './app'
import type { Env } from './app'

// naru 예비 배포용 엔트리 — 환경변수는 systemd EnvironmentFile로 주입
const env: Env = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  PROVIDER: process.env.PROVIDER,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
  MODEL: process.env.MODEL,
  REASONING_EFFORT: process.env.REASONING_EFFORT,
  MAX_DAILY_CALLS: process.env.MAX_DAILY_CALLS,
}

const app = createApp(() => env)
const port = Number(process.env.PORT) || 8787
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`overmind-proxy listening on :${info.port}`)
})
