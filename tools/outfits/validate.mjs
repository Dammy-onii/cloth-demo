// No downloads: bundle the local drafts with the already-installed esbuild, then check every cut.
import { build } from 'esbuild'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const dir = await mkdtemp(join(tmpdir(), 'cloth-outfit-check-'))
try {
  const bundle = join(dir, 'drafts.mjs')
  await build({ stdin: { contents: "export {draftOutfitPiece} from './src/outfits/drafts'; export {GUIDE_OUTFITS} from './src/outfits/catalog'", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: bundle })
  const { draftOutfitPiece, GUIDE_OUTFITS } = await import(pathToFileURL(bundle).href)
  const manifest = JSON.parse(await readFile('public/models/manifest.json', 'utf8'))
  let checked = 0
  for (const gender of ['female', 'male']) {
    const g = manifest.genders[gender], file = await readFile(`public/models/${g.file}`)
    const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
    const variant = (size, pose) => g.variants.find(v => v.size === size && v.pose === pose)
    const body = { ...g, gender, index: new Uint32Array(buffer, g.indexOffset, g.indexCount), labels: new Uint8Array(buffer, g.labelOffset, g.vertexCount),
      positions: (size, pose) => new Float32Array(buffer, variant(size, pose).offset, g.vertexCount * 3),
      joints: (size, pose) => variant(size, pose).joints,
      measurements: size => ({ fitted: variant(size, 'apose').measurements, chart: variant(size, 'apose').chart }),
      segment: name => g.segments.indexOf(name) }
    for (const size of ['S', 'M', 'XL']) for (const outfit of GUIDE_OUTFITS.filter(o => o.genders.includes(gender))) {
      const lift = new Float32Array(body.vertexCount)
      for (const piece of outfit.pieces) {
        const garment = draftOutfitPiece(piece.cut, body, size, lift.slice()), n = garment.rest.length / 3
        assert(n > 0 && garment.index.length > 0, 'empty mesh')
        for (const name of ['rest', 'flat', 'uv', 'covers']) assert(garment[name].every(Number.isFinite), `${piece.cut}: non-finite ${name}`)
        assert(garment.index.every(v => v < n), 'triangle out of bounds')
        assert(garment.seams.every(v => v < n), 'seam out of bounds')
        assert(garment.src.every(v => v < body.vertexCount), 'body attachment out of bounds')
        for (let v = 0; v < lift.length; v++) if (garment.covers[v]) lift[v] = Math.max(lift[v], garment.covers[v] + 0.003)
        checked++
      }
      console.log(`PASS ${gender} ${size} ${outfit.id}`)
    }
  }
  console.log(`Checked ${checked} garment meshes. This checks topology data, not visual fit.`)
} finally { await rm(dir, { recursive: true, force: true }) }
