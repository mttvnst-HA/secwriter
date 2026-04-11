import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    setupFiles: ['./src/lib/__tests__/setup.js'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'server/**'],
  },
})
