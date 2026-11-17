import { loadBodySet, POSES, type Gender, type Pose, type Size } from '../body/bodySet'
import { GUIDE_OUTFITS, type GuideOutfit } from './catalog'
import type { WardrobeStage } from './wardrobeStage'

// MessageChannel, not setTimeout: a hidden tab throttles timers to ~1 s and the audit would crawl.
const yieldFrame = () => new Promise<void>(resolve => { const c = new MessageChannel(); c.port1.onmessage = () => resolve(); c.port2.postMessage(0) })

type Fit = { outfit: GuideOutfit; gender: Gender; size: Size; pose: Pose }

export async function renderAudit(stage: WardrobeStage, scope: boolean | Fit, status: (message: string) => void) {
  const snapshot = (window as Window & { __snapshot?: (view: string, reduced?: boolean) => string }).__snapshot
  if (!snapshot) throw new Error('Viewer is still loading.')
  const sizes: Size[] = scope === true ? ['M', 'S', 'XL'] : ['M']
  const fits = typeof scope === 'object' ? [scope] : sizes.flatMap(size =>
    GUIDE_OUTFITS.flatMap(outfit => outfit.genders.flatMap(gender =>
      POSES.map(({ id: pose }) => ({ outfit, gender, size, pose })))))
  let count = 0
  for (const { outfit, gender, size, pose } of fits) {
    const label = `${outfit.id}-${gender}-${size}-${pose}`
    status(`Rendering ${label} · ${count} views saved`)
    if (typeof scope !== 'object') {
      stage.configure(await loadBodySet(gender), size, pose, outfit)
      for (let frame = 0; frame < 120 && !stage.idle; frame++) {
        stage.update(1 / 30)
        if (frame % 6 === 0) await yieldFrame()
      }
    }
    if (stage.error || !stage.idle) throw new Error(stage.error ?? `${label} did not settle`)
    for (const view of ['front', 'back', 'side', 'sideR', 'top', 'bottom', 'inclineFrontL', 'inclineFrontR', 'inclineBackL', 'inclineBackR']) {
      const result = await fetch('/api/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: snapshot(view, typeof scope !== 'object'), name: `audit-${label}-${view}` }),
      })
      if (!result.ok) throw new Error(`Could not save ${label} ${view}`)
      count++
    }
  }
  status(`Saved ${count} views`)
}
