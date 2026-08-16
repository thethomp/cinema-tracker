import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Fetcher } from '../src/fetch/fetcher.js'

/** Usage: npx tsx scripts/record-fixture.ts <url> <fixture-name> */
const [url, name] = process.argv.slice(2)
if (!url || !name) {
  console.error('Usage: record-fixture.ts <url> <fixture-name>')
  process.exit(1)
}

const fetcher = new Fetcher()
const html = await fetcher.text(url)
const path = join('tests/fixtures', `${name}.html`)
await mkdir(dirname(path), { recursive: true })
await writeFile(path, html, 'utf8')
console.log(`Wrote ${path} (${html.length} bytes)`)
