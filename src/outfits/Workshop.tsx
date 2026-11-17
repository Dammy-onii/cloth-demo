import { useEffect, useMemo, useState } from 'react'
import { loadBodySet, POSES, SIZES, type BodySet, type Gender, type Pose, type Size } from '../body/bodySet'
import { Viewer } from '../scene/Viewer'
import { GUIDE_OUTFITS } from './catalog'
import { renderAudit } from './renderAudit'
import { WardrobeStage } from './wardrobeStage'

export default function Workshop() {
  const stage = useMemo(() => new WardrobeStage(), [])
  const [outfit, select] = useState(() => GUIDE_OUTFITS.find(outfit => outfit.id === 'stripes') ?? GUIDE_OUTFITS[0])
  const [gender, setGender] = useState<Gender>(outfit.genders[0])
  const [size, setSize] = useState<Size>('M')
  const [pose, setPose] = useState<Pose>('relaxed') // the guide renders stand relaxed, not in an A-pose
  const [body, setBody] = useState<BodySet>()
  const [turntable, setTurntable] = useState(false)
  const [audit, setAudit] = useState('')
  const [auditing, setAuditing] = useState(false)
  const [error, setError] = useState('')
  const [draping, setDraping] = useState(false)
  useEffect(() => {
    const id = setInterval(() => setDraping(stage.draping), 250)
    return () => clearInterval(id)
  }, [stage])
  useEffect(() => {
    let cancelled = false
    loadBodySet(gender).then(model => { if (!cancelled) setBody(model) })
      .catch(() => { if (!cancelled) setError('Could not load the mannequin.') })
    return () => { cancelled = true }
  }, [gender])
  useEffect(() => {
    if (body?.gender === gender) stage.configure(body, size, pose, outfit)
  }, [stage, body, gender, size, pose, outfit])
  async function runAudit(scope: boolean | 'selected') {
    setAuditing(true)
    try { await renderAudit(stage, scope === 'selected' ? { outfit, gender, size, pose } : scope, setAudit) }
    catch (error) { setAudit(String(error)) }
    finally {
      if (body && scope !== 'selected') stage.configure(body, size, pose, outfit)
      setAuditing(false)
    }
  }
  return <div className="app">
    <aside className="panel">
      <h1>Outfit workshop</h1>
      <a href="/">Back to wardrobe</a>
      <fieldset disabled={auditing}>
      <section>
        <h2>Outfits</h2>
        <div className="outfits">{GUIDE_OUTFITS.map(option => <button key={option.id} className={option === outfit ? 'active' : ''} onClick={() => {
          select(option)
          if (!option.genders.includes(gender)) setGender(option.genders[0])
        }}>{option.name}</button>)}</div>
        <p className="hint">{outfit.pieces.map(piece => piece.name).join(' · ')}</p>
      </section>
      <section>
        <h2>Mannequin</h2>
        <div className="outfits">{outfit.genders.map(g => <button key={g} className={g === gender ? 'active' : ''} onClick={() => setGender(g)}>{g === 'female' ? 'Female' : 'Male'}</button>)}</div>
        <div className="outfits">{SIZES.map(s => <button key={s} className={s === size ? 'active' : ''} onClick={() => setSize(s)}>{s}</button>)}</div>
        <div className="outfits">{POSES.map(p => <button key={p.id} className={p.id === pose ? 'active' : ''} onClick={() => setPose(p.id)}>{p.label}</button>)}</div>
        <label className="check"><input type="checkbox" checked={turntable} onChange={event => setTurntable(event.target.checked)} /> Turntable</label>
      </section>
      </fieldset>
      {import.meta.env.DEV && <section>
        <button disabled={auditing || !body} onClick={() => void runAudit('selected')}>Audit selected fit</button>
        <button disabled={auditing || !body} onClick={() => void runAudit(false)}>Audit all outfits · M</button>
        <button disabled={auditing || !body} onClick={() => void runAudit(true)}>Audit all sizes and poses</button>
        <p role="status">{audit}</p>
      </section>}
      {error && <p role="alert">{error}</p>}
    </aside>
    <main className="stage">{draping && <div className="draping" aria-live="polite">Draping…</div>}<Viewer stage={stage} turntable={turntable} garmentVisible onCanvas={() => {}} /></main>
  </div>
}
