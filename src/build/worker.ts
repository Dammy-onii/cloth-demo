// Runs a pattern program (or interprets a spec) away from the page, and sews its pieces. A program is
// code Claude wrote from a photo, so it runs in a worker with the network and storage taken away first;
// the page stops it if it runs too long (run.ts).
import type { BodySet, Size } from '../body/bodySet'
import { assemble, bodyLookup } from '../pattern/assemble'
import { makeKit, type ProgramGarment } from './kit'
import { specToProgram } from './spec'
import type { BodySnapshot, BuildRequest, BuiltGarment } from './run'

const reply = self.postMessage.bind(self)
// nothing a program needs; nothing it should reach
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'navigator']) {
  try { Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false }) } catch { /* not present */ }
}

function bodyOf(s: BodySnapshot): BodySet {
  return {
    gender: s.gender, vertexCount: s.vertexCount, index: s.index, labels: s.labels, segments: s.segments, variants: [],
    positions: () => s.positions,
    joints: () => s.joints,
    measurements: () => s.measurements,
    segment: (name: string) => s.segments.indexOf(name),
  }
}

self.onmessage = (e: MessageEvent<BuildRequest>) => {
  const { id, mode, source, body: snap } = e.data
  try {
    const body = bodyOf(snap)
    const kit = makeKit(body, snap.size as Size)
    let garments: ProgramGarment[]
    if (mode === 'spec') garments = specToProgram(kit, typeof source === 'string' ? JSON.parse(source) : source)
    else {
      const run = new Function('kit', `"use strict";\n${source}\n;return build(kit)`) as (k: typeof kit) => ProgramGarment[]
      garments = run(kit)
    }
    if (!Array.isArray(garments) || !garments.length) throw new Error('the pattern made no garments')
    const lookup = bodyLookup(snap.positions, snap.labels, snap.segments)
    const built: BuiltGarment[] = garments.map((g, i) => {
      // tight fits are stretched on across the cloth (see Piece.stretch)
      if (g.fit === 'tight') for (const p of g.pieces) p.stretch ??= ['jersey', 'knit', 'synthetic', 'silk'].includes(g.fabric) ? 0.05 : 0.02
      const garment = assemble(g.pieces, g.seams, { spacing: 0.02, band: g.band }, lookup)
      return {
        name: String(g.name ?? `Garment ${i + 1}`), layer: Number(g.layer ?? i), kind: g.kind ?? 'top', fabric: g.fabric ?? 'cotton',
        color: /^#[0-9a-f]{6}$/i.test(g.color) ? g.color : '#808080', color2: /^#[0-9a-f]{6}$/i.test(g.color2 ?? '') ? g.color2 : undefined, print: g.print, fit: g.fit ?? 'regular', hold: g.hold ?? 'shoulders',
        garment,
      }
    })
    reply({ id, ok: true, built })
  } catch (err) {
    reply({ id, ok: false, error: err instanceof Error ? `${err.message}${err.stack ? '\n' + err.stack.split('\n').slice(0, 4).join('\n') : ''}` : String(err) })
  }
}
