import { chromium } from 'playwright'
const [, , htmlPath, pdfPath] = process.argv
const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.goto('file://' + htmlPath, { waitUntil: 'networkidle' })
await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, preferCSSPageSize: true })
await browser.close()
console.log('PDF_DONE ' + pdfPath)
