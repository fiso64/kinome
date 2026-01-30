import { test, expect } from '@playwright/test'

test('UI Verification', async ({ page }) => {
  page.on('console', (msg) => console.log(`[Browser Console] ${msg.type()}: ${msg.text()}`))
  page.on('pageerror', (err) => console.log(`[Browser Error]: ${err.message}`))
  page.on('requestfailed', (request) =>
    console.log(`[Request Failed] ${request.url()} - ${request.failure()?.errorText}`)
  )

  console.log('Navigating to home...')
  await page.goto('http://localhost:3000')

  // Wait for the app to initialize
  await page.waitForLoadState('networkidle')

  // Take a screenshot of the initial state
  await page.screenshot({ path: 'test-results/ui-initial.png' })

  // Check for expected UI elements
  // Either "Welcome to Media Browser" OR a folder title should be visible
  const content = await page.content()
  console.log('Page Content Length:', content.length)

  const welcomeHeading = page.locator('h2', { hasText: 'Welcome to Media Browser' })
  const folderHeader = page.locator('.folder-header-title')

  if (await welcomeHeading.isVisible()) {
    console.log('Verify: Welcome screen is visible.')
    await expect(welcomeHeading).toBeVisible()
  } else if (await folderHeader.isVisible()) {
    console.log('Verify: Library content is visible.')
    await expect(folderHeader).toBeVisible()
  } else {
    console.log('Verify: Unknown state. Dumping body text...')
    console.log(await page.locator('body').innerText())
    throw new Error('Neither Welcome screen nor Folder header was found.')
  }
})
