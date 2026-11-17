// Local bridge from the web app to Claude Code's headless mode (`claude -p`).
// Uses your logged-in Claude subscription, so no API key — for personal local use only.
// Images are written to a fresh temp dir that is the CLI's working directory, read with the Read
// tool, then deleted. Only the Read tool is allowed.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const PORT = Number(process.env.BRIDGE_PORT ?? 8787)
// PATH first, then the per-user install location (`npm i -g --prefix ~/.local` or the native installer).
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? [path.join(os.homedir(), '.local/bin/claude')].find((p) => !onPath('claude') && existsSync(p)) ?? 'claude'
const TIMEOUT_MS = 180_000

function onPath(bin) {
  return spawnSync('which', [bin]).status === 0
}
const MAX_BODY = 20 * 1024 * 1024

const LEVELS = 'neck|shoulder|underbust|waist|high_hip|hip|crotch|mid_thigh|above_knee|knee|below_knee|mid_calf|ankle|floor'
const GARMENT_FIELDS = `{"slot": "top"|"bottom"|"dress"|"outer", "type": "blouse, wide-leg trousers, wrap mini dress…",
 "description": "one short sentence", "fit": "tight"|"regular"|"relaxed"|"oversized",
 "fabric": "jersey"|"cotton"|"linen"|"silk"|"denim"|"knit"|"synthetic"|"wool", "primaryColor": "#rrggbb",
 "neckline": "crew"|"v"|"scoop"|"boat"|"collar"|"strapless"|"off_shoulder"|"turtleneck",
 "sleeveEnd": "none"|"cap"|"bicep"|"elbow"|"forearm"|"wrist"|"knuckles",
 "topAt": LEVEL, "hemAt": LEVEL, "waistSeamAt": LEVEL,
 "bottomKind": "trousers"|"shorts"|"skirt", "legs": "skinny"|"straight"|"wide"|"flared", "skirt": "straight"|"aline"|"full",
 "print": "plain"|"allover"|"placed", "swatch": [x0, y0, x1, y1] | null, "swatchCm": number,
 "outline": [[x, y], ...],
 "rows": [{"y": y, "body": [xL, xR], "garment": [xL, xR] | null}, ...],
 "topLine": [[x, y], ...], "top": {"L": "shoulder"|"under_arm", "R": "shoulder"|"under_arm"},
 "hemLine": [[x, y], ...],
 "openings": [{"kind": "cut-out"|"keyhole"|"open side", "points": [[x, y], ...], "confidence": 0-1}],
 "slits": [{"top": [x, y], "hem": [x, y], "confidence": 0-1}],
 "occluded": [[[x, y], ...], ...],
 "sleeves": {"L": {"end": [x, y], "hemWidth": number, "width": "fitted"|"regular"|"loose"} | null, "R": ... | null},
 "back": {"neckDepthAt": LEVEL, "openBack": {"topAt": LEVEL, "bottomAt": LEVEL, "width": 0-1} | null, "slit": {"topAt": LEVEL} | null},
 "hold": "shoulders"|"neckline"|"waist",
 "sleeveWidth": "fitted"|"regular"|"loose",
 "landmarks": {"neck": [x, y], "shoulderL": [x, y], "shoulderR": [x, y], "waistL": [x, y], "waistR": [x, y],
   "hemL": [x, y], "hemR": [x, y], "sleeveL": [x, y] | null, "sleeveR": [x, y] | null},
 "details": ["collar", "buttons", "open front", "belt", "cut-out", "wrap", "ruching", "sash", "pockets", …]}`

const ANALYZE_PROMPT = `Read the image file garment.jpg in the current directory. A shopper uploaded it to try the clothes on
a 3D model that sews each garment from a pattern and drapes it with cloth physics. Photos can be anything:
clothes worn by a person (mirror selfies, street or studio shots, any pose), on a hanger or mannequin,
flat-lays, product shots of a whole outfit, partly hidden by hair, hands, bags or other clothes, or badly lit.
Look carefully before answering.

Reply with ONLY one JSON object, no prose, no code fence:
{"view": "worn"|"flat"|"hanger"|"mannequin"|"other",
 "body": {"neck": [x, y], "shoulderL": [x, y], "shoulderR": [x, y], "elbowL": [x, y], "elbowR": [x, y],
   "wristL": [x, y], "wristR": [x, y], "waistL": [x, y], "waistR": [x, y], "hipL": [x, y], "hipR": [x, y],
   "kneeL": [x, y], "kneeR": [x, y], "ankleL": [x, y], "ankleR": [x, y]} | null,
 "garments": [GARMENT, ...]}
where each GARMENT is
${GARMENT_FIELDS}
and LEVEL is one of ${LEVELS}.

All points are fractions of the image width (x, from the left) and height (y, from the top). L and R are the
image's left and right, not the wearer's.

body: only when a person or a mannequin wears the clothes: the wearer's own joints, found first, wherever
the clothes cover them (estimate hidden ones from the visible body). Otherwise null.

garments: every separate garment worth trying on, outermost last: a top, bottoms, a dress, a jacket or coat
(slot "outer"). Leave out shoes, bags, jewellery, hats, scarves and underwear. A garment that is one piece
from the shoulders down past the hips is a "dress"; so is a jumpsuit.
- topAt / hemAt: where the garment starts and ends on the body. For a worn photo, compare its edges with the
  wearer's joints you found (a hem level with the knees is "knee", halfway down the shin "mid_calf"). For a
  flat-lay or hanger, judge from the garment's proportions as it would sit on a person. Bottoms start at
  "waist", "high_hip" or "hip". waistSeamAt only matters for dresses ("underbust" for an empire line).
- sleeveEnd: where the sleeves end on the arm, judged against the elbows and wrists.
- neckline "off_shoulder" when the neckline runs across the upper arms with the shoulders bare (sleeves may
  still be there); "strapless" when nothing goes over or around the shoulders.
- bottomKind, legs: for bottoms. skirt: the silhouette of a skirt, or a dress's skirt, below the waist.
- print: "plain" for a single colour (sheen, folds and shading are only light); "allover" for a repeating
  pattern or texture over the whole fabric (plaid, check, stripes, florals, denim, knit, brocade); "placed"
  only for a print, logo or panel that must sit where it is.
- swatch (needed for "allover", useful for all): a box lying wholly on this garment's own fabric, as flat,
  evenly lit and front-on as possible, containing no button, placket, pocket, collar, seam, hem, edge, strong
  fold, highlight, shadow, skin, other clothes or anything in front: pick the widest plain area, spanning
  whole pattern repeats if there is a pattern. swatchCm: its real width on the garment in cm.
- outline: 8 to 24 points tracing this garment's outer edge clockwise, leaving out skin, other garments and
  anything seen through an open front.
- landmarks: points on this garment: neck centre, outer shoulder points, side edges at its waist, hem corners,
  sleeve hem centres (null without sleeves). Bottoms: waistL/R are the waistband's ends, hemL/R the outer hem
  corners.

THE GARMENT'S OWN STRUCTURE. Never assume a standard shirt, dress or trouser shape: trace this garment as it
is, keeping every asymmetry, opening, slit and odd neckline. Don't tidy, mirror or "repair" anything.
- rows: from the garment's top edge down to its hem, one row every 4 to 6 % of the image height. y is the
  row's height; body is the x of the wearer's (or mannequin's) body edges at that height, the torso or both
  legs together, under the clothes where hidden (for a flat-lay, where a body wearing it would be); garment
  is the x of this garment's own left and right edges there: the body of the garment only, never sleeves,
  arms or anything hanging beside it; null above its side seams (the neckline and straps).
- topLine: the front's top edge, image-left to image-right, from where it leaves one side to where it reaches
  the other, with a point at every turn: a V's two origins and its lowest point, a sweetheart's dips, a
  one-shoulder strap's peak. top.L / top.R: whether the front goes up over that shoulder (a strap, shoulder
  seam or set-in sleeve: "shoulder") or stops below it (strapless or off-shoulder: "under_arm").
- hemLine: the hem, image-left to image-right, with a point at every turn: a diagonal or uneven hem keeps
  its real heights on each side.
- openings: every intentional hole inside the garment's outline on the front (a waist cut-out, keyhole,
  open side), traced as a closed polygon. Skin seen past the garment's outer edge is not an opening.
- slits: each slit, from its top to the hem.
- occluded: areas where something in front hides the garment (an arm, hand, hair, bag or phone). They are
  fabric, never openings.
- sleeves: per image side, where the sleeve ends (the centre of its hem), how wide its hem opening is across
  (hemWidth, as a fraction of the image width: a bell sleeve's is far wider than the wrist) and how it sits
  on the arm; null for none.
- back: what the back is most likely to be: its neckline depth, an open back, a back slit.
- hold: where the garment hangs from: its shoulders, an elastic neckline (strapless or off-shoulder) or its
  waist (skirts).
- sleeveWidth: how the sleeves sit on the arms: "fitted" (on the skin), "regular" or "loose".
- details: features the pattern can't show yet that a shopper would notice.`

const reviewPrompt = (context, hasPhoto) => `Read render.png in the current directory${hasPhoto ? ' and the shopper\'s photo garment.jpg' : ''}.
render.png is a real-time 3D render of a realistic human model (with a face and hair, standing in a
${context.pose ?? 'relaxed'} pose in a plain studio) wearing garments sewn from patterns and draped with cloth
physics.${hasPhoto ? ' They are meant to recreate the clothes in garment.jpg.' : ''}
The current reading of each garment, by index: ${JSON.stringify(context.garments ?? context)}

Compare each garment in the render with ${hasPhoto ? 'the same garment in the photo' : 'its description'}: where it starts and ends on the
body (hems against the knees and ankles, sleeves against the elbows and wrists), neckline, fit, the shape of
the skirt or legs, colour and print. Ignore the model's face, hair, skin and shoes, the background, and
details the reading lists as not modelled yet.

Reply with ONLY one JSON object, no prose, no code fence:
{"score": 1-10, "verdict": "one sentence", "issues": ["specific, at most 5"],
 "corrections": [{"index": number, "hemAt"?: LEVEL, "topAt"?: LEVEL, "sleeveEnd"?: "none"|"cap"|"bicep"|"elbow"|"forearm"|"wrist"|"knuckles",
   "fit"?: "tight"|"regular"|"relaxed"|"oversized", "neckline"?: "crew"|"v"|"scoop"|"boat"|"collar"|"strapless"|"off_shoulder"|"turtleneck",
   "legs"?: "skinny"|"straight"|"wide"|"flared", "skirt"?: "straight"|"aline"|"full", "primaryColor"?: "#rrggbb"}]}
LEVEL is one of ${LEVELS}. Only correct what is clearly different from ${hasPhoto ? 'the photo' : 'the description'}.`

const refinePrompt = (garments, pose) => `Read garment.jpg (the shopper's photo) and render.png (a 3D model, in a
${pose} pose, wearing garments sewn and draped from the trace below) in the current directory.
Each garment was drawn from this trace of the photo, in the photo's coordinates (fractions of its width and
height, L/R the image's sides):
${JSON.stringify(garments)}

Compare the render with the photo garment by garment: length on each side, how tight or loose it sits,
the neckline, the sleeves (length, and how wide they are at the hem), openings (missing, misplaced, or there
when the photo has none), slits, and the colour or print. The model's body, pose and the studio are
different from the photo on purpose; judge the garments only.

Then correct the trace so the next render matches the photo: move or remove wrong points, add what was
missed, and keep everything that was right. The trace is the photo's truth; correct it where it misread the
photo. "fitScale" (optional, 0.4 to 2) makes the drafted garment tighter (< 1) or looser (> 1) than the trace
says, for when it reads right but drapes too loose or tight.

Reply with ONLY one JSON object, no prose, no code fence:
{"score": 1-10, "verdict": "one sentence", "issues": ["specific, at most 5"],
 "garments": [{"index": number, "fitScale"?: number, ...the corrected garment, in the same fields as above...}]}
List only the garments that need a change; an empty list when the render already matches.`

// ---- Claude drafts the outfit itself, as the workshop outfits are drafted: a pattern program, or a spec
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
const EXAMPLES = ['whiteCutoutMini', 'denimBellTop', 'ribbedMaxiBolero']
/** the references Claude reads before drafting: the guide, the format, and the hand-drafted examples */
const referenceFiles = (mode) => ({
  'garment-guide.md': read('docs/garment-guide.md'),
  [mode === 'code' ? 'pattern-api.md' : 'pattern-spec.md']: read(mode === 'code' ? 'docs/pattern-api.md' : 'docs/pattern-spec.md'),
  ...Object.fromEntries(EXAMPLES.map((n) => [`example-${n}.js`, read(`src/build/programs/${n}.js`)])),
})

const photoNames = (photos) => photos.map((_, i) => `photo${i + 1}.jpg`)
const imagesOf = (photos, extra = {}) => ({ ...Object.fromEntries(photos.map((p, i) => [`photo${i + 1}.jpg`, p])), ...extra })

const draftTask = (mode, photos) => `You are the pattern maker for a 3D fashion try-on. Read, in the current directory:
${photoNames(photos).join(', ')}: the shopper's photo${photos.length > 1 ? 's (together they make one outfit: a top in one and bottoms in another, say)' : ''};
garment-guide.md: the house rules for drafting and fitting;
${mode === 'code' ? 'pattern-api.md: how to write a pattern program, and the kit it gets' : 'pattern-spec.md: the pattern spec format'};
the example-*.js files: outfits drafted by hand from reference photos, the standard to match.

Study every garment in the photo${photos.length > 1 ? 's' : ''} the way a pattern maker would: its silhouette and fit, where each part sits on the
body (necklines, shoulders, armholes, sleeve ends, waist, hip, hems, on each side separately), its openings,
cut-outs, slits, asymmetry, layering, fabric, colour and print. Leave out shoes, bags, jewellery and the
background. Never assume a standard shape and never symmetrise, simplify or fill an intentional feature:
draft the garment that is actually there, layered as it is worn (or would be worn, for a flat-lay).`

const buildPrompt = (mode, photos) => `${draftTask(mode, photos)}

${mode === 'code'
    ? 'Then write the pattern program. Reply with one line describing the outfit, then the whole program in a single ```js code block. Nothing else.'
    : 'Then write the pattern spec. Reply with ONLY the spec JSON object, no prose, no code fence.'}`

const refineBuildPrompt = (mode, photos, source) => `${draftTask(mode, photos)}

render.png shows the model wearing the outfit drafted from this ${mode === 'code' ? 'program' : 'spec'}:
${source}

Compare the render with the photo${photos.length > 1 ? 's' : ''} garment by garment and fix the ${mode === 'code' ? 'program' : 'spec'} wherever the render is
wrong: lengths on each side, fit, necklines, sleeves, openings, slits, layering, fabric, colour, print. The
model's body, pose and the studio are different from the photo on purpose. Keep what is right.

${mode === 'code'
    ? 'Reply with a first line "SCORE n/10: what is off", then the whole corrected program in a single ```js code block. If nothing needs changing, reply with the SCORE line only.'
    : 'Reply with ONLY one JSON object: {"score": n, "verdict": "what is off", "spec": the whole corrected spec, or null if nothing needs changing}.'}`

/** a reply with a one-line note and a fenced program */
function parseProgram(text) {
  const m = /```(?:js|javascript)?\s*\n([\s\S]*?)```/.exec(text)
  const first = text.trim().split('\n')[0].trim()
  const score = /SCORE\s*(\d+)/i.exec(first)
  return { note: first.startsWith('```') ? '' : first, program: m ? m[1].trim() : null, score: score ? Number(score[1]) : undefined }
}

const BUILD = { maxTurns: 14, timeout: 420_000 }

// ---- Claude sculpts the user's head: compares the bald 3D head with their photo and sets the face controls
const sculptPrompt = (controls, round, mode = 'depth') => `You are sculpting a 3D head to look like a real person. Read, in the current directory:
face.jpg: the person's photo;
head-front.jpg, head-three.jpg, head-side.jpg: the 3D head as it is now (bald on purpose, studio lighting),
from the front, three-quarter and side.

The head's shape is a mix of named shape controls, each from -1 to 1 (0 is the model's neutral face; names
read as what +1 does: "nose-scale-horiz-incr" +1 widens the nose, -1 narrows it; l- and r- are the face's own
left and right). The current values (round ${round}):
${JSON.stringify(controls)}

The head's proportions seen face on are already matched to the photo point by point (its landmarks are moved
onto the photo's). What a single photo can't show is depth, so judge mostly from the three-quarter and side
views, against what the photo implies, the way a portrait sculptor would: how far the nose projects and its
bridge, tip and nostrils; lip fullness (upper and lower) and how far the lips stand out; the brow ridge; eye
depth and lids; cheekbone prominence and cheek fullness; jaw angle; chin projection; forehead slope. Also fix
anything still clearly off face on.
Ignore skin colour, hair, lighting, makeup and expression. ${mode === 'full'
    ? `You are building this head entirely yourself: no measurements of the photo were taken, so every control listed
is yours to set, face on and in depth. ${round === 1 ? 'The head starts as the neutral face: set every control the person clearly differs on.' : 'Correct what is still off, comparing the photo with the renders carefully.'} Move each control at most 0.5
from its current value this round.`
    : `The controls listed are only the depth ones (the face-on proportions are fixed from the photo). Change only those
that are clearly off, in small steps (at most 0.25 from the current value), and keep the rest.`}

Also read the person's features that aren't shape: eye (iris) colour, lip colour, facial hair, and hair.

Reply with ONLY one JSON object, no prose, no code fence:
{"score": 1-10 (how closely the head's shape matches now), "verdict": "one sentence",
 "controls": {"control-name": value, ...only the ones to change},
 "features": {"skinColor": "#rrggbb", "eyeColor": "#rrggbb", "lipColor": "#rrggbb", "facialHair": "none"|"stubble"|"moustache"|"goatee"|"beard",
   "hair": "short description of the hair: type, length, style", "hairColor": "#rrggbb"}}`

function runClaude(prompt, cwd, { maxTurns = 4, timeout = TIMEOUT_MS, parse = extractJson } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      CLAUDE_BIN,
      ['-p', prompt, '--output-format', 'json', '--max-turns', String(maxTurns), '--allowedTools', 'Read',
        '--disallowedTools', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e.code === 'ENOENT' ? new Error(NOT_INSTALLED) : e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let envelope
      try {
        envelope = JSON.parse(out)
      } catch {
        return reject(new Error(err.trim() || out.trim() || `claude exited with ${code}`))
      }
      if (envelope.is_error || code !== 0) {
        const msg = String(envelope.result || err.trim() || 'Claude returned an error')
        return reject(new Error(/authenticat|log ?in|oauth/i.test(msg) ? `${msg}. ${LOGIN_HINT}` : msg))
      }
      try {
        resolve(parse(envelope.result))
      } catch (e) {
        reject(new Error(`Could not parse Claude's reply: ${e.message}\n${String(envelope.result).slice(0, 500)}`))
      }
    })
  })
}

const LOGIN_HINT = 'Run `claude auth login` in a terminal, finish signing in, then reload.'
const NOT_INSTALLED = 'Claude Code CLI not found. Install it with `npm install -g @anthropic-ai/claude-code`, run `claude` once to log in, then restart the bridge.'

function extractJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('no JSON object in reply')
  return JSON.parse(text.slice(start, end + 1))
}

async function withImages(images, fn, files = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloth-demo-'))
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text)
    for (const [name, dataUrl] of Object.entries(images)) {
      if (!dataUrl) continue
      const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl)
      if (!m) throw new Error(`${name} must be a PNG/JPEG/WebP data URL`)
      await writeFile(path.join(dir, name), Buffer.from(m[2], 'base64'))
    }
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const routes = {
  // Dev aid: saves a render to the OS temp dir so it can be inspected outside the browser.
  'POST /api/snapshot': async ({ image, name = 'snapshot' }) => {
    const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(image ?? '')
    if (!m) throw new Error('image must be a PNG/JPEG data URL')
    const file = path.join(os.tmpdir(), `cloth-demo-${String(name).replace(/[^\w-]/g, '')}.${m[1] === 'png' ? 'png' : 'jpg'}`)
    await writeFile(file, Buffer.from(m[2], 'base64'))
    return { file }
  },
  'GET /api/health': () =>
    new Promise((resolve) => {
      // `claude auth status` prints JSON with loggedIn; installed-but-logged-out is the common failure.
      const child = spawn(CLAUDE_BIN, ['auth', 'status'])
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.on('error', () => resolve({ ok: false, error: NOT_INSTALLED }))
      child.on('close', () => {
        try {
          const status = JSON.parse(out)
          resolve(status.loggedIn ? { ok: true, version: status.authMethod } : { ok: false, error: `Claude Code is installed but not logged in. ${LOGIN_HINT}` })
        } catch {
          resolve({ ok: false, error: 'Could not read `claude auth status`.' })
        }
      })
    }),
  'POST /api/analyze-garment': ({ image }) =>
    withImages({ 'garment.jpg': image }, (dir) => runClaude(ANALYZE_PROMPT, dir)),
  'POST /api/sculpt-face': ({ face, front, three, side, controls, round, mode }) =>
    withImages({ 'face.jpg': face, 'head-front.jpg': front, 'head-three.jpg': three, 'head-side.jpg': side },
      (dir) => runClaude(sculptPrompt(controls, round, mode), dir, { maxTurns: 8, timeout: 300_000 })),
  'POST /api/build-code': ({ photos }) =>
    withImages(imagesOf(photos), (dir) => runClaude(buildPrompt('code', photos), dir, { ...BUILD, parse: parseProgram }), referenceFiles('code')),
  'POST /api/build-spec': ({ photos }) =>
    withImages(imagesOf(photos), (dir) => runClaude(buildPrompt('spec', photos), dir, BUILD), referenceFiles('spec')),
  'POST /api/refine-code': ({ photos, render, source }) =>
    withImages(imagesOf(photos, { 'render.png': render }), (dir) => runClaude(refineBuildPrompt('code', photos, source), dir, { ...BUILD, parse: parseProgram }), referenceFiles('code')),
  'POST /api/refine-spec': ({ photos, render, source }) =>
    withImages(imagesOf(photos, { 'render.png': render }), (dir) => runClaude(refineBuildPrompt('spec', photos, source), dir, BUILD), referenceFiles('spec')),
  'POST /api/refine': ({ render, photo, garments, pose }) =>
    withImages({ 'render.png': render, 'garment.jpg': photo }, (dir) => runClaude(refinePrompt(garments, pose), dir)),
  'POST /api/review': ({ render, photo, context }) =>
    withImages({ 'render.png': render, 'garment.jpg': photo }, (dir) => runClaude(reviewPrompt(context, Boolean(photo)), dir)),
}

http
  .createServer(async (req, res) => {
    const handler = routes[`${req.method} ${req.url}`]
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (!handler) return send(404, { error: 'not found' })
    try {
      let raw = ''
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > MAX_BODY) return send(413, { error: 'image too large' })
      }
      send(200, await handler(raw ? JSON.parse(raw) : {}))
    } catch (e) {
      console.error(`[bridge] ${req.url}:`, e.message)
      send(502, { error: e.message })
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`[bridge] Claude bridge on http://127.0.0.1:${PORT} using "${CLAUDE_BIN}"`))
