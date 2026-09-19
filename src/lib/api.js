/**
 * API client.
 *
 * Talks to the Next.js backend under /api/ui, which serves the real scheduling
 * store — surgeons, duty rosters, sleep logs, commitments and cases — in this
 * app's vocabulary. See lib/ui-adapter.js on the backend for the translation.
 *
 * If the backend is not reachable, every call falls back to an equivalent
 * in-browser implementation so the app stays demonstrable on its own. The
 * header shows which of the two is live.
 *
 *   GET  /roster
 *        -> { surgeons: Surgeon[], cases: Case[], generatedAt }
 *   POST /sleep-log   { surgeonId, start, end, quality, source }
 *   POST /flag        { surgeonId, reason, severity } | { surgeonId, clear }
 *   POST /register    { name, specialty, role, habitualSleep, recentSleep[] }
 *   POST /assign      { caseId, surgeonId, reason }
 *
 * Assignment recommendations are computed in the browser (lib/assign.js) over
 * whichever dataset is live. Against the backend that means real duty hours and
 * real sleep logs, so the recommendation is real either way — it just never
 * needs a round trip to re-rank when the scheduler drags the horizon.
 *
 * Timestamps may be epoch milliseconds or ISO strings; both are accepted.
 */

import { buildDataset } from './seed.js'
import { assess, curve } from './fatigue.js'
import { suggestAssignment } from './assign.js'
import { HOUR } from './time.js'

const BASE = '/api/ui'
const TIMEOUT_MS = 4000

let mode = 'unknown' // 'live' | 'mock' | 'unknown'
const listeners = new Set()

export function getMode() {
  return mode
}

export function onModeChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function setMode(next) {
  if (mode === next) return
  mode = next
  for (const fn of listeners) fn(next)
}

// --- Timestamp normalisation ----------------------------------------------

function toMs(v) {
  if (v == null) return v
  if (typeof v === 'number') return v
  const parsed = Date.parse(v)
  return Number.isNaN(parsed) ? v : parsed
}

const TIME_KEYS = new Set(['start', 'end', 'at', 'generatedAt', 't'])

function normalizeTimes(value) {
  if (Array.isArray(value)) return value.map(normalizeTimes)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = TIME_KEYS.has(k) ? toMs(v) : normalizeTimes(v)
    }
    return out
  }
  return value
}

// --- Transport -------------------------------------------------------------

/**
 * The backend wraps every payload as { ok, meta, data } so responses carry
 * their own provenance. Unwrap it here rather than in every caller, and
 * surface the backend's error message when there is one — a 409 from the
 * duty-hour gate is something the scheduler needs to read, not a generic
 * "request failed".
 */
async function request(path, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
    })

    const json = await res.json().catch(() => null)

    if (!res.ok) {
      const message = json?.error?.message
      // A refusal is a real answer from a reachable backend. Throwing a marked
      // error keeps withFallback from mistaking it for the server being down
      // and silently switching the whole app to mock data.
      if (message) {
        const err = new Error(message)
        err.rejected = true
        throw err
      }
      throw new Error(`${res.status} ${res.statusText}`)
    }

    setMode('live')
    return normalizeTimes(json?.data ?? json)
  } finally {
    clearTimeout(timer)
  }
}

/** Try the backend; on a transport failure, run the local equivalent. */
async function withFallback(path, options, fallback) {
  if (mode === 'mock') return fallback()
  try {
    return await request(path, options)
  } catch (err) {
    if (err?.rejected) throw err
    setMode('mock')
    return fallback()
  }
}

const post = (body) => ({ method: 'POST', body: JSON.stringify(body) })

// --- Local dataset (mock mode) --------------------------------------------

let local = null

function localData() {
  if (!local) local = buildDataset(Date.now())
  return local
}

/** Whatever is currently live, for the client-side assignment model. */
let live = null

function activeData() {
  return live ?? localData()
}

function findSurgeon(id) {
  return activeData().surgeons.find((s) => s.id === id) ?? null
}

// --- Public API ------------------------------------------------------------

export const api = {
  async roster() {
    const data = await withFallback('/roster', undefined, () => {
      const d = localData()
      return { surgeons: d.surgeons, cases: d.cases, generatedAt: d.generatedAt }
    })
    live = data
    return data
  },

  async assessFatigue({ surgeonId, at = Date.now(), horizonHours = 48 }) {
    const s = findSurgeon(surgeonId)
    if (!s) return null
    return {
      surgeonId,
      ...assess(s, at),
      curve: curve(s, at - 12 * HOUR, at + horizonHours * HOUR),
    }
  },

  async suggestAssignment({ caseId }) {
    return suggestAssignment(activeData(), caseId, Date.now())
  },

  async logSleep(entry) {
    return withFallback('/sleep-log', post(entry), () => {
      const s = findSurgeon(entry.surgeonId)
      if (!s) return { ok: false }
      s.sleepLog = [...s.sleepLog, entry].sort((a, b) => a.start - b.start)
      return { ok: true, surgeon: s }
    })
  },

  async flag({ surgeonId, reason, severity }) {
    return withFallback('/flag', post({ surgeonId, reason, severity }), () => {
      const s = findSurgeon(surgeonId)
      if (!s) return { ok: false }
      s.flags = [...s.flags, { at: Date.now(), reason, severity }]
      return { ok: true, surgeon: s }
    })
  },

  async clearFlag({ surgeonId }) {
    return withFallback('/flag', post({ surgeonId, clear: true }), () => {
      const s = findSurgeon(surgeonId)
      if (!s) return { ok: false }
      s.flags = []
      return { ok: true, surgeon: s }
    })
  },

  async register(profile) {
    return withFallback('/register', post(profile), () => {
      const d = localData()
      const id = `s${d.surgeons.length + 1}`
      const surgeon = {
        id,
        duty: [],
        sleepLog: [],
        commitments: [],
        flags: [],
        registered: true,
        ...profile,
      }
      d.surgeons = [...d.surgeons, surgeon]
      return { ok: true, surgeon }
    })
  },

  async reassign({ caseId, surgeonId, reason }) {
    return withFallback('/assign', post({ caseId, surgeonId, reason }), () => {
      const c = localData().cases.find((x) => x.id === caseId)
      if (!c) return { ok: false }
      c.surgeonId = surgeonId
      return { ok: true, case: c }
    })
  },
}
