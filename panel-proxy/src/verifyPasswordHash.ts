import { authConfig, verifyPanelPassword } from './auth'
import { promptHidden } from './passwordPrompt'

async function main() {
  if (!authConfig.loginEnabled) {
    console.error('PANEL_LOGIN_PASSWORD_HASH is not configured')
    process.exit(1)
  }

  const password = process.argv[2] || await promptHidden('Enter panel password to verify: ')
  if (!password) {
    console.error('Password cannot be empty')
    process.exit(1)
  }

  if (!verifyPanelPassword(password)) {
    console.error('Password does not match current PANEL_LOGIN_PASSWORD_HASH')
    process.exit(1)
  }

  console.log('Password matches current PANEL_LOGIN_PASSWORD_HASH')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Failed to verify password')
  process.exit(1)
})
