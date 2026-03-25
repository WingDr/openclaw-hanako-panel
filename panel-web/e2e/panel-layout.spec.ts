import { expect, test } from '@playwright/test'

test('chat side panels can collapse, expand, and resize', async ({ page }) => {
  await page.goto('/chat')

  const leftPanel = page.locator('.pw-panel-frame-left')
  const rightPanel = page.locator('.pw-panel-frame-right')
  const leftToggle = page.getByRole('button', { name: 'Close left panel' })
  const rightToggle = page.getByRole('button', { name: 'Close right panel' })
  const readPanelWidth = async (selector: string) => {
    return await page.locator(selector).evaluate((element) => Math.round(element.getBoundingClientRect().width))
  }

  await expect(page.getByText('Hanako Workspace')).toBeVisible()
  await expect(page.getByText('Agent files')).toBeVisible()

  const leftWidthBeforeResize = await readPanelWidth('.pw-panel-frame-left')
  const leftResizeHandle = page.getByRole('button', { name: 'Resize left panel' })
  const leftResizeBox = await leftResizeHandle.boundingBox()
  if (!leftResizeBox) {
    throw new Error('Unable to resolve left resize handle')
  }

  await page.mouse.move(leftResizeBox.x + (leftResizeBox.width / 2), leftResizeBox.y + (leftResizeBox.height / 2))
  await page.mouse.down()
  await page.mouse.move(leftResizeBox.x + 96, leftResizeBox.y + (leftResizeBox.height / 2), { steps: 10 })
  await page.mouse.up()

  const leftWidthAfterResize = await readPanelWidth('.pw-panel-frame-left')
  expect(leftWidthAfterResize).toBeGreaterThan(leftWidthBeforeResize + 40)

  await leftToggle.click()
  await expect(leftPanel).toHaveCSS('width', '0px')
  await expect(page.getByRole('button', { name: 'Open left panel' })).toBeVisible()

  await page.getByRole('button', { name: 'Open left panel' }).click()
  await expect(page.getByText('Hanako Workspace')).toBeVisible()

  const rightWidthBeforeResize = await readPanelWidth('.pw-panel-frame-right')
  const rightResizeHandle = page.getByRole('button', { name: 'Resize right panel' })
  const rightResizeBox = await rightResizeHandle.boundingBox()
  if (!rightResizeBox) {
    throw new Error('Unable to resolve right resize handle')
  }

  await page.mouse.move(rightResizeBox.x + (rightResizeBox.width / 2), rightResizeBox.y + (rightResizeBox.height / 2))
  await page.mouse.down()
  await page.mouse.move(rightResizeBox.x - 96, rightResizeBox.y + (rightResizeBox.height / 2), { steps: 10 })
  await page.mouse.up()

  const rightWidthAfterResize = await readPanelWidth('.pw-panel-frame-right')
  expect(rightWidthAfterResize).toBeGreaterThan(rightWidthBeforeResize + 40)

  await rightToggle.click()
  await expect(rightPanel).toHaveCSS('width', '0px')
  await expect(page.getByRole('button', { name: 'Open right panel' })).toBeVisible()

  await page.getByRole('button', { name: 'Open right panel' }).click()
  await expect(page.getByText('Agent files')).toBeVisible()
})
