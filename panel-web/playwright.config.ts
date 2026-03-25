import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const currentDir = path.dirname(fileURLToPath(import.meta.url))

function resolveBrowserExecutablePath(): string | undefined {
  const envExecutable = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim()
  if (envExecutable) {
    return envExecutable
  }

  const openClawConfigPath = path.join(os.homedir(), '.openclaw', 'openclaw.json')
  try {
    const raw = fs.readFileSync(openClawConfigPath, 'utf8')
    const parsed = JSON.parse(raw) as { browser?: { executablePath?: string } }
    return parsed.browser?.executablePath
  } catch {
    return undefined
  }
}

const proxyPort = 22946
const webPort = 4173
const gatewayPort = 23938

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    headless: true,
    viewport: {
      width: 1600,
      height: 1200,
    },
    launchOptions: {
      executablePath: resolveBrowserExecutablePath(),
    },
  },
  webServer: [
    {
      command: '../panel-proxy/node_modules/.bin/tsx ../panel-proxy/test/mockGatewayServer.ts',
      url: `http://127.0.0.1:${gatewayPort}`,
      reuseExistingServer: !process.env.CI,
      cwd: currentDir,
      env: {
        ...process.env,
        MOCK_GATEWAY_PORT: String(gatewayPort),
      },
      timeout: 30_000,
    },
    {
      command: '../panel-proxy/node_modules/.bin/tsx ../panel-proxy/test/startProxyFixtureServer.ts',
      url: `http://127.0.0.1:${proxyPort}/api/bootstrap`,
      reuseExistingServer: !process.env.CI,
      cwd: currentDir,
      env: {
        ...process.env,
        PANEL_PROXY_PORT: String(proxyPort),
        MOCK_GATEWAY_PORT: String(gatewayPort),
      },
      timeout: 30_000,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: !process.env.CI,
      cwd: currentDir,
      env: {
        ...process.env,
        PANEL_WEB_PORT: String(webPort),
        PANEL_PROXY_PORT: String(proxyPort),
        VITE_PANEL_API_BASE_URL: `http://127.0.0.1:${proxyPort}`,
        VITE_PANEL_WS_URL: `ws://127.0.0.1:${proxyPort}/ws`,
      },
      timeout: 30_000,
    },
  ],
})
