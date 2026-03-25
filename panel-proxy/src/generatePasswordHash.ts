import { promises as fs } from 'node:fs'
import path from 'node:path'
import { buildPasswordHash } from './auth'
import { promptHidden } from './passwordPrompt'

const envPath = path.resolve(__dirname, '..', '..', '.env')
const printOnlyFlags = new Set(['--print', '--print-only', '--stdout'])

function upsertEnvValue(source: string, key: string, value: string): string {
  const assignment = `${key}=${value}`
  const pattern = new RegExp(`^${key}=.*$`, 'm')

  if (pattern.test(source)) {
    return source.replace(pattern, assignment)
  }

  const normalized = source.endsWith('\n') || source.length === 0 ? source : `${source}\n`
  return `${normalized}${assignment}\n`
}

async function resolvePassword(): Promise<string> {
  const args = process.argv.slice(2)
  const passwordFromArg = args.find((arg) => !arg.startsWith('--'))
  if (passwordFromArg) {
    return passwordFromArg
  }

  const first = await promptHidden('Enter panel password: ')
  const second = await promptHidden('Confirm panel password: ')

  if (!first) {
    console.error('Password cannot be empty')
    process.exit(1)
  }

  if (first !== second) {
    console.error('Passwords do not match')
    process.exit(1)
  }

  return first
}

async function main() {
  const args = process.argv.slice(2)
  const password = await resolvePassword()
  const hash = buildPasswordHash(password)
  const printOnly = args.some((arg) => printOnlyFlags.has(arg))

  if (printOnly) {
    console.log(hash)
    return
  }

  let envSource = ''
  try {
    envSource = await fs.readFile(envPath, 'utf8')
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : undefined
    if (code !== 'ENOENT') {
      throw error
    }
  }

  const nextEnv = upsertEnvValue(envSource, 'PANEL_LOGIN_PASSWORD_HASH', hash)
  await fs.writeFile(envPath, nextEnv, 'utf8')

  console.log(`Updated ${envPath}`)
  console.log('PANEL_LOGIN_PASSWORD_HASH has been written to .env')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Failed to read password')
  process.exit(1)
})
