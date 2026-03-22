import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const envDir = path.resolve(__dirname, '..')
  const env = loadEnv(mode, envDir, '')
  const panelWebPort = parseInt(env.PANEL_WEB_PORT ?? '', 10)
  const port = Number.isInteger(panelWebPort) && panelWebPort > 0 ? panelWebPort : 5173

  return {
    envDir,
    plugins: [react()],
    server: {
      port,
      host: true
    },
    preview: {
      port,
      host: true
    },
    build: {
      outDir: 'dist'
    }
  }
})
