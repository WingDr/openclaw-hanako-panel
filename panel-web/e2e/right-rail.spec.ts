import { expect, test } from '@playwright/test'

test('workspace editor and cron dialogs work end-to-end', async ({ page }) => {
  const replaceCodeMirrorContent = async (editorKey: 'workspace' | 'cronJson', nextValue: string) => {
    await page.evaluate(([key, value]) => {
      const view = (window as Window & {
        __HANAKO_TEST_EDITORS__?: Record<string, {
          state: { doc: { length: number } }
          dispatch: (spec: { changes: { from: number; to: number; insert: string } }) => void
        }>
      }).__HANAKO_TEST_EDITORS__?.[key]
      if (!view) {
        throw new Error('Unable to resolve CodeMirror view for test')
      }

      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: value as string,
        },
      })
    }, [editorKey, nextValue] as const)
  }

  const readCodeMirrorContent = async (editorKey: 'workspace' | 'cronJson') => {
    return await page.evaluate((key) => {
      const view = (window as Window & {
        __HANAKO_TEST_EDITORS__?: Record<string, {
          state: { doc: { toString: () => string } }
        }>
      }).__HANAKO_TEST_EDITORS__?.[key]
      if (!view) {
        throw new Error('Unable to resolve CodeMirror view for test')
      }

      return view.state.doc.toString()
    }, editorKey)
  }

  await page.goto('/chat')

  await expect(page.getByText('Hanako Workspace')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'workspace-mon3tr' })).toBeVisible()
  await expect(page.getByText('Scheduled runs')).toBeVisible()

  const readmeNode = page.locator('.rct-tree-item-button', { hasText: 'README.md' }).first()
  await readmeNode.click()
  await page.getByTestId('workspace-open-file').click()

  await expect(page.getByTestId('workspace-editor-dialog')).toBeVisible()
  await replaceCodeMirrorContent('workspace', '# Mon3tr Workspace\n\nEdited from browser test.\n')
  await page.getByRole('button', { name: 'Save file' }).click()
  await expect(page.getByRole('button', { name: 'Save file' })).toBeEnabled()
  await page.getByTestId('workspace-editor-dialog').getByRole('button', { name: 'Close' }).click()

  await readmeNode.click()
  await page.getByTestId('workspace-open-file').click()
  const workspaceDialog = page.getByTestId('workspace-editor-dialog')
  await expect
    .poll(async () => await readCodeMirrorContent('workspace'))
    .toContain('Edited from browser test.')
  await workspaceDialog.getByRole('button', { name: 'Add to chat' }).click()
  await expect(page.getByText('File: README.md')).toBeVisible()

  await workspaceDialog.getByRole('button', { name: 'Close' }).click()

  await page.getByTestId('cron-new-button').click()
  await expect(page.getByTestId('cron-config-dialog')).toBeVisible()
  await page.getByTestId('cron-name-input').fill('Main Browser Cron')
  await page.getByTestId('cron-execution-select').selectOption('main')
  await page.getByTestId('cron-message-input').fill('Main session reminder from browser test.')
  await page.getByTestId('cron-save-button').click()
  await expect(page.getByText('Main Browser Cron')).toBeVisible()

  await page.getByTestId('cron-new-button').click()
  await page.getByTestId('cron-name-input').fill('Isolated Browser Cron')
  await page.getByTestId('cron-execution-select').selectOption('isolated')
  await page.getByTestId('cron-message-input').fill('Collect an isolated status report.')
  await page.getByTestId('cron-model-input').fill('openai/gpt-5.4')
  await page.getByTestId('cron-save-button').click()
  await expect(page.getByText('Isolated Browser Cron')).toBeVisible()

  await page.getByTestId('cron-new-button').click()
  await page.getByTestId('cron-mode-json').click()
  await replaceCodeMirrorContent('cronJson', '{')
  await page.getByTestId('cron-save-button').click()
  await expect(page.getByTestId('cron-error-note')).toContainText('JSON')

  await replaceCodeMirrorContent('cronJson', JSON.stringify({
    name: 'Advanced JSON Cron',
    agentId: 'mon3tr',
    enabled: true,
    schedule: { kind: 'cron', expr: '0 18 * * 1-5', tz: 'Asia/Shanghai', staggerMs: 30000 },
    sessionTarget: 'current',
    wakeMode: 'next-heartbeat',
    payload: { kind: 'systemEvent', text: 'Advanced JSON payload' },
    delivery: { mode: 'webhook', url: 'https://example.com/hook' },
    deleteAfterRun: true,
  }, null, 2))
  await page.getByTestId('cron-save-button').click()
  await expect(page.getByText('Advanced JSON Cron')).toBeVisible()

  const isolatedCard = page.getByTestId('cron-card-job-isolated')
  await isolatedCard.getByRole('button', { name: 'Enable' }).click()
  await expect(isolatedCard.getByText('enabled')).toBeVisible()

  const advancedCard = page.locator('[data-testid^="cron-card-"]', { hasText: 'Advanced JSON Cron' }).first()
  await advancedCard.getByRole('button', { name: 'Run now' }).click()

  await advancedCard.getByRole('button', { name: 'Edit' }).click()
  await page.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByText('Advanced JSON Cron')).toHaveCount(0)
})
