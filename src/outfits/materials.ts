import * as THREE from 'three'
import type { PieceStyle } from './catalog'
import type { Look } from '../scene/stage'

const cache = new Map<string, THREE.Texture>()
/**
 * Washed denim, painted over one whole leg: the pattern UVs are metres up from each piece's hem, so a
 * texture 1.2 m tall can fade the thighs and knees where wear lightens real jeans. Flat indigo with
 * only a weave normal map read as blue plastic next to the guides.
 */
function denimWash(color: string): Look {
  const key = 'denim:' + color
  if (!cache.has(key)) {
    const W = 512, H = 1024, canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H
    const c = canvas.getContext('2d')!
    c.fillStyle = color; c.fillRect(0, 0, W, H)
    let seed = 7
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    // slub: the warp yarn is unevenly dyed, so fine vertical streaks run along the grain
    for (let i = 0; i < 2600; i++) {
      const x = rand() * W, y = rand() * H, light = rand() < 0.5
      c.fillStyle = light ? 'rgba(255,255,255,0.045)' : 'rgba(0,10,40,0.05)'
      c.fillRect(x, y, 1, 20 + rand() * 90)
    }
    // y = 0 is the hem (canvas bottom). Fade bands centred on the knee (~0.48 m) and upper thigh (~0.8 m).
    const fade = (centre: number, spread: number, alpha: number) => {
      const y = H - centre / 1.2 * H, g = c.createLinearGradient(0, y - spread, 0, y + spread)
      g.addColorStop(0, 'rgba(225,235,245,0)'); g.addColorStop(0.5, `rgba(225,235,245,${alpha})`); g.addColorStop(1, 'rgba(225,235,245,0)')
      c.fillStyle = g; c.fillRect(0, y - spread, W, 2 * spread)
    }
    fade(0.48, 70, 0.16); fade(0.82, 120, 0.2)
    // the hem stays dark, where the cloth is folded and rubs least
    const g = c.createLinearGradient(0, H - 60, 0, H); g.addColorStop(0, 'rgba(0,8,30,0)'); g.addColorStop(1, 'rgba(0,8,30,0.25)')
    c.fillStyle = g; c.fillRect(0, H - 60, W, 60)
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8
    cache.set(key, texture)
  }
  return { texture: cache.get(key)!, uv: 'tiled', tile: 1.2 }
}

export function outfitLook(style: PieceStyle): Look | undefined {
  if (!style.print && style.fabric === 'denim') return denimWash(style.color)
  if (!style.print) return undefined
  const key = `${style.print}:${style.color}`
  if (!cache.has(key)) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256
    const c = canvas.getContext('2d')!
    c.fillStyle = style.color; c.fillRect(0, 0, 256, 256)
    if (style.print === 'stripe') {
      for (let x = 0; x < 256; x += 64) {
        c.fillStyle = '#b87946'; c.fillRect(x, 0, 12, 256)
        c.fillStyle = '#ddd1b7'; c.fillRect(x + 15, 0, 3, 256)
        c.fillStyle = '#27323a'; c.fillRect(x + 22, 0, 5, 256)
        c.fillStyle = '#c2c4b8'; c.fillRect(x + 30, 0, 2, 256)
      }
    } else if (style.print === 'pinstripe') {
      c.fillStyle = '#a88777'
      for (let x = 0; x < 256; x += 32) c.fillRect(x, 0, 1.5, 256)
    } else {
      c.strokeStyle = '#304968'; c.lineWidth = 2
      for (let y = -64; y < 320; y += 64) for (let x = -64; x < 320; x += 64) {
        const xx = x + (y % 128 ? 32 : 0)
        for (let k = 0; k < 4; k++) {
          c.beginPath(); c.ellipse(xx + 12 * Math.cos(k * Math.PI / 2), y + 12 * Math.sin(k * Math.PI / 2), 7, 18, k * Math.PI / 2, 0, Math.PI * 2); c.stroke()
        }
      }
    }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4
    cache.set(key, texture)
  }
  return { texture: cache.get(key)!, uv: 'tiled', tile: style.print === 'stripe' ? 0.16 : 0.12 }
}
