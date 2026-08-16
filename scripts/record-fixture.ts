import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Fetcher } from '../src/fetch/fetcher.js'

/** Usage: npx tsx scripts/record-fixture.ts <url> <fixture-name> [extension] */
const [url, name, extension = 'html'] = process.argv.slice(2)
if (!url || !name) {
  console.error('Usage: record-fixture.ts <url> <fixture-name> [extension]')
  process.exit(1)
}

const fetcher = new Fetcher()
const body = await fetcher.text(url)
const path = join('tests/fixtures', `${name}.${extension}`)
await mkdir(dirname(path), { recursive: true })
await writeFile(path, body, 'utf8')
console.log(`Wrote ${path} (${body.length} bytes)`)
