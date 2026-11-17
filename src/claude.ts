// Client for server/claude-bridge.mjs (local Claude Code CLI, no API key).

export interface Correction {
  index: number
  hemAt?: string
  topAt?: string
  sleeveEnd?: string
  fit?: 'tight' | 'regular' | 'relaxed' | 'oversized'
  neckline?: 'crew' | 'v' | 'scoop' | 'boat' | 'collar' | 'strapless' | 'off_shoulder' | 'turtleneck'
  legs?: 'skinny' | 'straight' | 'wide' | 'flared'
  skirt?: 'straight' | 'aline' | 'full'
  primaryColor?: string
}

/** Claude's comparison of the render with the photo, and what to correct in each garment it read. */
export interface Review {
  score: number
  verdict: string
  issues: string[]
  corrections?: Correction[]
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({ error: `Bridge not reachable (HTTP ${res.status}). Is \`npm run dev\` running?` }))
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json as T
}

export const claudeHealth = () =>
  call<{ ok: boolean; version?: string; error?: string }>('health').catch((e: Error) => ({ ok: false, error: e.message }))

export const analyzeGarment = (image: string) => call<Record<string, unknown>>('analyze-garment', { image })

export const reviewRender = (render: string, photo: string | undefined, context: unknown) =>
  call<Review>('review', { render, photo, context })

/** Claude compares the render with the photo and returns corrected traces for the garments that need them. */
export interface Refinement {
  score: number
  verdict: string
  issues: string[]
  garments: (Record<string, unknown> & { index: number })[]
}
export const refineRender = (render: string, photo: string, garments: unknown[], pose: string) =>
  call<Refinement>('refine', { render, photo, garments, pose })

/** Claude drafts the outfit in the photos as a pattern program (or spec), the way the workshop outfits are drafted. */
export const buildWithClaude = (mode: 'code' | 'spec', photos: string[]) =>
  call<{ note?: string; program?: string | null } & Record<string, unknown>>(`build-${mode}`, { photos })

/** Claude compares the render with the photos and returns a corrected program (or spec), or none if it matches. */
export const refineBuild = (mode: 'code' | 'spec', photos: string[], render: string, source: string) =>
  call<{ note?: string; program?: string | null; score?: number; verdict?: string; spec?: unknown } & Record<string, unknown>>(`refine-${mode}`, { photos, render, source })

/** Claude compares the bald 3D head with the person's photo and sets the face controls (src/face). */
export interface Sculpt {
  score: number
  verdict: string
  controls: Record<string, number>
  features?: { skinColor?: string; eyeColor?: string; lipColor?: string; facialHair?: string; hair?: string; hairColor?: string }
}
/** `mode: 'full'`: Claude builds the head entirely, every control; 'depth': it refines depth after the landmark fit. */
export const sculptFace = (face: string, views: { front: string; three: string; side: string }, controls: Record<string, number>, round: number, mode: 'depth' | 'full' = 'depth') =>
  call<Sculpt>('sculpt-face', { face, ...views, controls, round, mode })
