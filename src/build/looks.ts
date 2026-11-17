// Fabric looks for pattern-program garments: the outfits page's prints, plus a rib knit and an open crochet.
import * as THREE from 'three'
import { outfitLook } from '../outfits/materials'
import type { Look } from '../scene/stage'
import type { BuiltGarment } from './run'

const cache = new Map<string, THREE.Texture>()
const tex = (key: string, size: number, paint: (c: CanvasRenderingContext2D, n: number) => void) => {
  if (!cache.has(key)) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size
    paint(canvas.getContext('2d')!, size)
    const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8
    cache.set(key, t)
  }
  return cache.get(key)!
}

export function programLook(g: Pick<BuiltGarment, 'print' | 'color' | 'color2' | 'fabric'>): Look | undefined {
  if (g.print === 'plaid' || g.print === 'check') {
    // woven checks: bands of the second colour across and down, crossing darker; a plaid adds fine lines
    const c2 = g.color2 ?? '#efe7d6'
    return { uv: 'tiled', tile: g.print === 'plaid' ? 0.09 : 0.03, texture: tex(`${g.print}:${g.color}:${c2}`, 128, (c, n) => {
      c.fillStyle = g.color; c.fillRect(0, 0, n, n)
      c.globalAlpha = 0.55; c.fillStyle = c2
      c.fillRect(0, n * 0.1, n, n * 0.3); c.fillRect(n * 0.1, 0, n * 0.3, n)
      if (g.print === 'plaid') {
        c.globalAlpha = 0.5; c.fillStyle = '#1d1712'
        c.fillRect(0, n * 0.62, n, n * 0.06); c.fillRect(n * 0.62, 0, n * 0.06, n)
        c.globalAlpha = 0.7; c.fillStyle = c2
        c.fillRect(0, n * 0.82, n, 2); c.fillRect(n * 0.82, 0, 2, n)
      }
      c.globalAlpha = 1
    }) }
  }
  if (g.print === 'rib') {
    // knit ribs: a raised wale and a sunk one every 3 mm
    return { uv: 'tiled', tile: 0.012, texture: tex('rib:' + g.color, 64, (c, n) => {
      c.fillStyle = g.color; c.fillRect(0, 0, n, n)
      for (let x = 0; x < n; x += 16) {
        c.fillStyle = 'rgba(0,0,0,0.22)'; c.fillRect(x + 11, 0, 4, n)
        c.fillStyle = 'rgba(255,255,255,0.08)'; c.fillRect(x + 3, 0, 4, n)
      }
    }) }
  }
  if (g.print === 'crochet') {
    // open crochet: chunky yarn round square holes you can see the skin and dress through
    return { uv: 'tiled', tile: 0.045, cutout: true, texture: tex('crochet:' + g.color, 128, (c, n) => {
      c.clearRect(0, 0, n, n)
      c.strokeStyle = g.color; c.lineCap = 'round'
      const cell = n / 4
      for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
        c.lineWidth = 9
        c.strokeRect(i * cell - cell / 2 + 6, j * cell - cell / 2 + 6, cell - 12, cell - 12)
      }
      // the stitches' twist
      c.strokeStyle = 'rgba(0,0,0,0.12)'; c.lineWidth = 2
      for (let i = 0; i <= 8; i++) { c.beginPath(); c.moveTo(i * cell / 2, 0); c.lineTo(i * cell / 2 + 6, n); c.stroke() }
    }) }
  }
  if (g.print === 'denim' || (!g.print && g.fabric === 'denim')) return outfitLook({ cut: 'shirt', name: '', color: g.color, fabric: 'denim' })
  if (g.print === 'stripe' || g.print === 'pinstripe' || g.print === 'brocade') return outfitLook({ cut: 'shirt', name: '', color: g.color, fabric: g.fabric, print: g.print })
  return undefined
}
