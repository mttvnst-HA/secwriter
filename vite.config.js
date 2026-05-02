import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Worktree-friendly fs allowlist. Worktrees under .claude/worktrees/<name>
    // have no local node_modules — packages resolve to the main repo's
    // node_modules three levels up. Without this, Vite's @fs guard returns
    // 403 for files like harper.js's WASM blob, breaking the grammar tier
    // in worktree-based dev. See issue #36.
    fs: { allow: ['../../..', '.'] },
  },
  test: {
    environment: 'node',
    setupFiles: ['./src/lib/__tests__/setup.js'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'server/**', '.claude/**'],
  },
})
