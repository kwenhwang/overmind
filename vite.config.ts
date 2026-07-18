import { defineConfig } from 'vite'
import { execSync } from 'node:child_process'

// 빌드 식별자 — 화면 버전표시로 캐시(옛 빌드) 여부를 즉시 진단
let BUILD = 'dev'
try {
  BUILD = execSync('git rev-parse --short HEAD').toString().trim()
} catch {
  /* git 없음 */
}

// GitHub Pages 프로젝트 사이트는 /<repo>/ 하위 경로에서 서빙됨.
// Actions 배포 워크플로가 VITE_BASE를 주입하고, 로컬 dev는 '/' 사용.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  define: { __BUILD__: JSON.stringify(BUILD) },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      // 멀티 페이지: 게임(index) + 에셋 뷰어(viewer)
      input: {
        main: 'index.html',
        viewer: 'viewer.html',
      },
    },
  },
})
