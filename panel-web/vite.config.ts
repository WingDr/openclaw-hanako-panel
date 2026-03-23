import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const envDir = path.resolve(__dirname, '..')
  const env = loadEnv(mode, envDir, '')
  const panelWebPort = parseInt(env.PANEL_WEB_PORT ?? '', 10)
  const panelProxyPort = parseInt(env.PANEL_PROXY_PORT ?? '', 10)
  const port = Number.isInteger(panelWebPort) && panelWebPort > 0 ? panelWebPort : 5173
  const proxyPort = Number.isInteger(panelProxyPort) && panelProxyPort > 0 ? panelProxyPort : 22846
  const proxyTarget = `http://127.0.0.1:${proxyPort}`

  return {
    envDir,
    plugins: [react()],
    server: {
      port,
      host: true,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '/ws': {
          target: proxyTarget,
          ws: true,
          changeOrigin: true,
        },
      },
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
