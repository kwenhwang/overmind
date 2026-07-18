/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 개발용 프록시 오버라이드 (예: http://localhost:8917) */
  readonly VITE_PROXY_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** 빌드 식별자 (vite define) — 화면 버전표시로 캐시 진단 */
declare const __BUILD__: string
