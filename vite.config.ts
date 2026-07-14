import { defineConfig } from 'vite'

// GitHub Pages 프로젝트 사이트는 /<repo>/ 하위 경로에서 서빙됨.
// Actions 배포 워크플로가 VITE_BASE를 주입하고, 로컬 dev는 '/' 사용.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  build: {
    target: 'es2022',
    sourcemap: false,
  },
})
