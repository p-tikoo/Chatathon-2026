/**
 * API client.
 *
 * Talks to the backend at /api. If the backend is not reachable, every call
 * falls back to an equivalent in-browser implementation so the app stays
 * demonstrable on its own. The header shows which of the two is live.
 *
 * Contract expected of the backend:
 *
 *   GET  /roster
 *        -> { surgeons: Surgeon[], cases: Case[], generatedAt }
 *   POST /assess-fatigue   { surgeonId, at?, horizonHours? }
 *        -> { surgeonId, score, band, drivers[], curve[] }
 *   POST /suggest-assignment { caseId }
 *        -> { caseId, recommendation, current, candidates[], ineligible[] }
 *   POST /sleep-log        { surgeonId, start, end, quality, source }
 *        -> { ok, surgeon }
 *   POST /flag             { surgeonId, reason, severity }
 *        -> { ok, surgeon }
 *   POST /register         { name, specialty, role, chronotype, ... }
 *        -> { ok, surgeon }
 *
 * Timestamps may be epoch milliseconds or ISO strings; both are accepted.
 */

import { buildDataset } from './seed.js'
import { assess, curve } from './fatigue.js'
import { suggestAssignment } from './assign.js'
import { HOUR } from './time.js'

const BASE = '/api'
const TIMEOUT_MS = 2500

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

async function request(path, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const json = await res.json()
    setMode('live')
    return normalizeTimes(json)
  } finally {
    clearTimeout(timer)
  }
}

/** Try the backend; on any transport failure, run the local equivalent. */
async function withFallback(path, options, fallback) {
  if (mode === 'mock') return fallback()
  try {
    return await request(path, options)
  } catch {
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

function findSurgeon(id) {
  return localData().surgeons.find((s) => s.id === id) ?? null
}

// --- Public API ------------------------------------------------------------

export const api = {
  async roster() {
    return withFallback('/roster', undefined, () => {
      const d = localData()
      return { surgeons: d.surgeons, cases: d.cases, generatedAt: d.generatedAt }
    })
  },

  async assessFatigue({ surgeonId, at = Date.now(), horizonHours = 48 }) {
    return withFallback('/assess-fatigue', post({ surgeonId, at, horizonHours }), () => {
      const s = findSurgeon(surgeonId)
      if (!s) return null
      const result = assess(s, at)
      return {
        surgeonId,
        ...result,
        curve: curve(s, at - 12 * HOUR, at + horizonHours * HOUR),
      }
    })
  },

  async suggestAssignment({ caseId }) {
    return withFallback('/suggest-assignment', post({ caseId }), () =>
      suggestAssignment(localData(), caseId, Date.now())
    )
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
    return withFallback(`/flag/${surgeonId}`, { method: 'DELETE' }, () => {
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

  async reassign({ caseId, surgeonId }) {
    return withFallback('/assign', post({ caseId, surgeonId }), () => {
      const c = localData().cases.find((x) => x.id === caseId)
      if (!c) return { ok: false }
      c.surgeonId = surgeonId
      return { ok: true, case: c }
    })
  },
}
