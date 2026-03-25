import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function main() {
  const proxyPort = process.env.PANEL_PROXY_PORT || '22846'
  const gatewayPort = process.env.MOCK_GATEWAY_PORT || '22838'
  const fixtureRoot = path.resolve(__dirname, 'fixtures', 'openclaw-template')
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hanako-panel-e2e-'))
  const openClawDir = path.join(tempRoot, '.openclaw')
  const workspaceDir = path.join(openClawDir, 'workspace-mon3tr')

  await fs.mkdir(openClawDir, { recursive: true })
  await fs.cp(fixtureRoot, openClawDir, { recursive: true })

  const openClawConfig = {
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
      list: [
        {
          id: 'mon3tr',
          workspace: workspaceDir,
        },
      ],
    },
  }

  await fs.writeFile(path.join(openClawDir, 'openclaw.json'), `${JSON.stringify(openClawConfig, null, 2)}\n`, 'utf8')

  process.env.OPENCLAW_CONFIG_DIR = openClawDir
  process.env.OPENCLAW_GATEWAY_WS_URL = `ws://127.0.0.1:${gatewayPort}`
  process.env.PANEL_PROXY_PORT = proxyPort
  process.env.PANEL_LOGIN_PASSWORD_HASH = ''
  process.env.PANEL_PROXY_API_TOKEN = ''

  const { createApp } = await import('../src/app')
  const app = await createApp()
  await app.listen({ port: Number(proxyPort), host: '127.0.0.1' })
  console.log(`proxy-fixture listening on http://127.0.0.1:${proxyPort}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Failed to start proxy fixture server')
  process.exit(1)
})
