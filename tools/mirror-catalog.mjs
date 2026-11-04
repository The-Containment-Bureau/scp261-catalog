// ─────────────────────────────────────────────────────────────────────────────
// VENDORED COPY — do not edit here.
//
// The canonical file lives in the site repository at tools/mirror-catalog.mjs, next to the
// /api/nft endpoint it consumes, where it is reviewed together with the schema it depends on.
// Change it there first, then copy it across.
//
// It is duplicated into this repository because the site repository is private: this repo's
// scheduled workflow cannot check it out without a token, and a public mirror should not need
// a credential to rebuild itself. If the two copies ever drift, the output diff is what will
// tell you — that is the reason the generator is deterministic.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Rebuild the public catalog mirror at github.com/The-Containment-Bureau/scp261-catalog.
 *
 * WHY A MIRROR AT ALL
 * -------------------
 * The site is the source of truth, and the site is one Railway service with one Postgres
 * behind it. A collector who buys an item should not have to trust that both stay up forever.
 * The mirror is a plain, public, versioned copy of every dispensed item - metadata AND image
 * bytes - that survives the app being down, moved or rewritten.
 *
 * WHY IT IS A PURE FUNCTION OF /api/nft
 * -------------------------------------
 * The mirror derives everything from one endpoint and writes NO timestamps of its own. Run it
 * twice with nothing dispensed in between and `git status` is clean. That makes the diff
 * meaningful: any change in the mirror is a real change in the collection, never mirror
 * bookkeeping. It also means the mirror can never quietly become a second source of truth.
 *
 *   node tools/mirror-catalog.mjs --out ../scp261-catalog
 *   node tools/mirror-catalog.mjs --out /tmp/cat --base https://scp261.org
 */
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
}

const BASE = (args.get('base') ?? 'https://scp261.org').replace(/\/+$/, '')
const OUT = args.get('out')
const RAW = (
  args.get('raw') ??
  'https://raw.githubusercontent.com/The-Containment-Bureau/scp261-catalog/main'
).replace(/\/+$/, '')

if (!OUT) {
  console.error('usage: node tools/mirror-catalog.mjs --out <dir> [--base <url>] [--raw <url>]')
  process.exit(2)
}

const json = (value) => JSON.stringify(value, null, 2) + '\n'

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'scp261-catalog-mirror' } })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return res.json()
}

async function getImage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'scp261-catalog-mirror' } })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  // The publishing rule says a listed item always has an image. If that ever stops being
  // true, the mirror must fail loudly rather than commit a token whose picture is an HTML
  // error page - a marketplace caches that miss and it is not recoverable by fixing the site.
  if (!type.startsWith('image/')) throw new Error(`GET ${url} -> content-type ${type || 'none'}`)
  return { bytes: Buffer.from(await res.arrayBuffer()), ext: type.includes('png') ? 'png' : 'jpg' }
}

const { collection, count, tokens } = await getJson(`${BASE}/api/nft`)
if (!Array.isArray(tokens) || tokens.length === 0) {
  throw new Error('collection endpoint returned no tokens - refusing to publish an empty mirror')
}
console.log(`${BASE}/api/nft -> ${count} token(s)\n`)

// Wipe the generated directories so a token that legitimately disappears cannot survive as a
// stale file. Everything else in the target (.git, LICENSE, anything a human added) is left
// alone.
for (const dir of ['metadata', 'images']) {
  await rm(path.join(OUT, dir), { recursive: true, force: true })
  await mkdir(path.join(OUT, dir), { recursive: true })
}

const index = []
let totalBytes = 0

for (const token of tokens) {
  const { edition, itemId, metadata, dispensedAt } = token

  // GUARD: the three ways to ask for one token must return the same document.
  //
  // The collection endpoint, the by-edition lookup and the by-slug lookup are three different
  // queries. They HAVE disagreed: the by-slug path compared a Postgres microsecond timestamp
  // against a millisecond JavaScript Date, so a row never counted itself and every by-slug
  // answer came back one edition short - /api/nft/1 said "edition 1" while
  // /api/nft/liquid-languor said "edition 0", for the same item.
  //
  // This is the last gate before writing a permanent, public record that other people may
  // mint from. Contradicting the site is worse than being a day late, so a mismatch fails the
  // whole run.
  for (const form of [String(edition), itemId]) {
    const other = await getJson(`${BASE}/api/nft/${form}`)
    if (JSON.stringify(other) !== JSON.stringify(metadata)) {
      throw new Error(
        `/api/nft/${form} disagrees with the collection document for edition ${edition} ` +
          `(${itemId}) - refusing to publish a record that contradicts the site`,
      )
    }
  }

  const { bytes, ext } = await getImage(metadata.image)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const imagePath = `images/${edition}.${ext}`

  await writeFile(path.join(OUT, imagePath), bytes)
  await writeFile(
    path.join(OUT, `metadata/${edition}.json`),
    // The mirrored document points at the mirrored bytes: a copy that depends on the site
    // for its image is not a copy.
    json({ ...metadata, image: `${RAW}/${imagePath}` }),
  )

  totalBytes += bytes.length
  index.push({
    edition,
    itemId,
    name: metadata.name,
    rarity: metadata.attributes.find((a) => a.trait_type === 'Rarity')?.value ?? null,
    category: metadata.attributes.find((a) => a.trait_type === 'Category')?.value ?? null,
    dispensedAt,
    metadata: `${RAW}/metadata/${edition}.json`,
    image: `${RAW}/${imagePath}`,
    imageBytes: bytes.length,
    imageSha256: sha256,
    itemPage: metadata.external_url,
    tokenUri: token.tokenUri,
  })

  console.log(
    `  #${String(edition).padStart(3)}  ${metadata.name.padEnd(26)} ` +
      `${String(bytes.length).padStart(9)} B  ${sha256.slice(0, 16)}`,
  )
}

await writeFile(path.join(OUT, 'collection.json'), json(collection))
await writeFile(
  path.join(OUT, 'index.json'),
  json({ collection, source: `${BASE}/api/nft`, count: index.length, tokens: index }),
)
await writeFile(path.join(OUT, 'README.md'), readme(collection, index, totalBytes))

console.log(
  `\nwrote ${index.length} token(s), ${(totalBytes / 1048576).toFixed(1)} MB of images -> ${OUT}`,
)

function readme(collection, index, bytes) {
  const rows = index
    .map(
      (t) =>
        `| ${t.edition} | [${t.name}](${t.itemPage}) | ${t.rarity} | ${t.category} | ` +
        `${t.dispensedAt.slice(0, 10)} | [json](metadata/${t.edition}.json) | ` +
        `\`${t.imageSha256.slice(0, 16)}\` |`,
    )
    .join('\n')

  return `# SCP-261 Catalog

${collection.description}

This repository is the **public mirror** of every item ever dispensed by the machine at
[scp261.org](${collection.external_link}). The site is the source of truth; this is the copy
that survives it.

## What is in here

| path | what it is |
| --- | --- |
| \`metadata/<edition>.json\` | [ERC-721 metadata](https://eips.ethereum.org/EIPS/eip-721#specification) for one item |
| \`images/<edition>.jpg\` | the item's studio picture, as the site shows it |
| \`index.json\` | the whole collection in one file, with a SHA-256 for every image |
| \`collection.json\` | contract-level metadata (OpenSea \`contractURI\` convention) |

Editions are permanent. An item's edition is its position in the dispense order, and that
order only ever appends - nothing is renumbered when a new item is vended.

## Using it as a token URI base

Nothing is minted yet. When it is, a contract can point at either copy:

\`\`\`
${collection.external_link}/api/nft/          # live, always current
https://raw.githubusercontent.com/The-Containment-Bureau/scp261-catalog/main/metadata/   # frozen per commit
\`\`\`

Both accept \`<tokenId>\` and \`<tokenId>.json\`.

## ⚠ Do not rename this org, this repo, or the default branch

Every \`image\` URL in every metadata document points at
\`raw.githubusercontent.com/The-Containment-Bureau/scp261-catalog/main/…\`. Those three names
are baked into each document, and into any token ever minted from one. Renaming the
organisation, renaming the repository, or changing the default branch away from \`main\`
breaks every image link that has ever been published — including ones already held by other
people, which cannot be edited.

If a rename is genuinely necessary: keep a redirect at the old name (GitHub does this
automatically for renamed repos and orgs, but *only* until someone else claims the old name),
and treat that as a temporary reprieve, not a fix.

## Verifying a copy

Every image in \`index.json\` carries its SHA-256. To check that a file here is byte-identical
to what the site shows:

\`\`\`bash
sha256sum images/1.jpg
curl -s "${collection.external_link}/api/items/<item-id>/display?v=2" | sha256sum
\`\`\`

The images are the items' studio pictures: every object on the same backdrop, at the same
size, without lettering. Items 1-8 were vended before the studio existed and were
re-photographed in it on 4 November 2026. The pictures they were dispensed with are kept at
\`${collection.external_link}/api/items/<item-id>/image\` and in this repository's history,
where the Bitcoin proofs of earlier versions still verify them.

## Proof of existence

Every version of \`index.json\` (the whole collection, with a SHA-256 for every image) is
timestamped in Bitcoin with [OpenTimestamps](https://opentimestamps.org). The proof sits beside
it as \`proofs/<sha256 of index.json>.ots\` and shows that this exact collection existed no later
than the Bitcoin block it is anchored in: no item can be added, removed or swapped afterwards
and backdated. A fresh proof is pending for a few hours until Bitcoin confirms it; the daily run
then upgrades it to a complete, self-contained proof.

It is evidence, not a token: nothing here is minted, owned or traded.

To check a proof yourself:

\`\`\`bash
pip install opentimestamps-client
sha256sum index.json                         # the proof is named after this hash
ots verify -f index.json proofs/<sha256>.ots
\`\`\`

Or drop \`index.json\` and its \`.ots\` file onto [opentimestamps.org](https://opentimestamps.org).

## How this file is produced

Regenerated by \`tools/mirror-catalog.mjs\` in the site repository, straight from
\`${collection.external_link}/api/nft\`. It writes no timestamps of its own, so re-running it
with nothing newly dispensed produces no diff.

## Size, and when it becomes a problem

${index.length} item(s), ${(bytes / 1048576).toFixed(1)} MB of images — an average of
**${Math.round(bytes / index.length / 1024)} KB per item**, committed to git history that
cannot be pruned without a rewrite. At that weight:

| items | repository size |
| --- | --- |
| 1,000 | ~${(bytes / index.length * 1000 / 1073741824).toFixed(2)} GB |
| 10,000 | ~${(bytes / index.length * 10000 / 1073741824).toFixed(1)} GB |

GitHub recommends staying under 1 GB and starts warning above 5 GB, so at the current image
weight this repository leaves the comfortable range somewhere around
**${Math.round(1073741824 / (bytes / index.length)).toLocaleString('en-US')} items**. The fix is upstream, at
generation time: smaller images make both the site and this mirror lighter. It is deliberately
*not* done here — the whole point of this copy is that its bytes are identical to what the
site serves, verifiable by the SHA-256 above. Re-encoding here would break that.

## The record

| # | item | rarity | category | dispensed | metadata | image sha256 |
| --- | --- | --- | --- | --- | --- | --- |
${rows}
`
}
