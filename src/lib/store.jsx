import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { api, getMode, onModeChange } from './api.js'
import { assess, curve } from './fatigue.js'
import { HOUR, MIN } from './time.js'

const StoreContext = createContext(null)

const TICK_MS = 60 * 1000
const HORIZON_HOURS = 48
const LOOKBACK_HOURS = 12

export function StoreProvider({ children }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [viewerId, setViewerId] = useState('s1')
  const [mode, setMode] = useState(getMode())
  const [now, setNow] = useState(() => Date.now())
  const [revision, setRevision] = useState(0)

  useEffect(() => onModeChange(setMode), [])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const roster = await api.roster()
      setData(roster)
      setError(null)
    } catch (e) {
      setError(e.message ?? 'Could not load the roster')
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Recompute projections on a 15-minute grid rather than every tick, so the
  // clock can move without re-running the model.
  const modelAnchor = Math.floor(now / (15 * MIN)) * 15 * MIN

  const projections = useMemo(() => {
    if (!data) return {}
    const from = modelAnchor - LOOKBACK_HOURS * HOUR
    const to = modelAnchor + HORIZON_HOURS * HOUR
    const out = {}
    for (const s of data.surgeons) {
      out[s.id] = {
        curve: curve(s, from, to),
        assessment: assess(s, modelAnchor),
      }
    }
    return out
  }, [data, modelAnchor, revision])

  const act = useCallback(
    async (fn) => {
      const result = await fn()
      await refresh()
      setRevision((r) => r + 1)
      return result
    },
    [refresh]
  )

  const value = useMemo(
    () => ({
      data,
      error,
      mode,
      now,
      viewerId,
      setViewerId,
      projections,
      horizonHours: HORIZON_HOURS,
      refresh,
      surgeon: (id) => data?.surgeons.find((s) => s.id === id) ?? null,
      casesFor: (id) =>
        (data?.cases ?? []).filter((c) => c.surgeonId === id).sort((a, b) => a.start - b.start),
      logSleep: (entry) => act(() => api.logSleep(entry)),
      raiseFlag: (payload) => act(() => api.flag(payload)),
      clearFlag: (payload) => act(() => api.clearFlag(payload)),
      register: (profile) => act(() => api.register(profile)),
      reassign: (payload) => act(() => api.reassign(payload)),
      suggest: (caseId) => api.suggestAssignment({ caseId }),
    }),
    [data, error, mode, now, viewerId, projections, refresh, act]
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used inside StoreProvider')
  return ctx
}
