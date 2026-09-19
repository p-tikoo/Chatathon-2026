import React, { useState } from 'react'
import { useStore } from './lib/store.jsx'
import SurgeonView from './views/SurgeonView.jsx'
import DirectorView from './views/DirectorView.jsx'
import RegisterView from './views/RegisterView.jsx'
import { EmptyState, Panel } from './components/ui.jsx'

function ModeIndicator({ mode }) {
  const live = mode === 'live'
  return (
    <span
      className="inline-flex items-center gap-1.5 text-meta text-ink-2"
      title={
        live
          ? 'Connected to the scheduling service'
          : 'The backend is not responding, so the model is running in this browser'
      }
    >
      <span
        aria-hidden="true"
        className="inline-block size-[7px] rounded-full"
        style={{
          background: live ? 'var(--color-ok-mark)' : 'var(--color-warn-mark)',
        }}
      />
      {live ? 'Service connected' : 'Local model'}
    </span>
  )
}

export default function App() {
  const store = useStore()
  const { data, error, mode, viewerId, setViewerId } = store
  const [registering, setRegistering] = useState(false)

  const surgeons = data?.surgeons ?? []

  function onSwitch(value) {
    setRegistering(false)
    setViewerId(value)
  }

  return (
    <div className="min-h-screen">
      <div className="border-b border-line bg-sunken px-4 py-1.5 text-meta text-ink-2">
        Synthetic data. Every surgeon, case, shift and sleep record in this
        application is fabricated for demonstration. Not a clinical decision tool.
      </div>

      <header className="sticky top-0 z-10 border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <p className="text-lead font-semibold text-ink">
              Theatre scheduling, fatigue-aware
            </p>
            <p className="text-meta text-ink-3">
              Two-process alertness model over the operating roster
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <ModeIndicator mode={mode} />

            <div className="flex items-center gap-2">
              <label htmlFor="viewer" className="text-meta font-medium text-ink-2">
                View as
              </label>
              <select
                id="viewer"
                value={registering ? 'register' : viewerId}
                onChange={(e) =>
                  e.target.value === 'register'
                    ? setRegistering(true)
                    : onSwitch(e.target.value)
                }
                className="rounded-control border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink transition-colors duration-150 hover:border-ink-3 focus:border-accent"
              >
                <option value="director">OR Director</option>
                <optgroup label="Surgeons">
                  {surgeons.map((s) => (
                    <option key={s.id} value={s.id}>
                      Dr. {s.name.split(' ').slice(-1)[0]} — {s.specialty}
                    </option>
                  ))}
                </optgroup>
                <option value="register">New surgeon registration</option>
              </select>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1240px] px-4 py-6">
        {error ? (
          <Panel className="mb-4">
            <EmptyState>{error}</EmptyState>
          </Panel>
        ) : null}

        {registering ? (
          <RegisterView
            onRegistered={(id) => {
              setRegistering(false)
              setViewerId(id)
            }}
          />
        ) : viewerId === 'director' ? (
          <DirectorView />
        ) : (
          <SurgeonView surgeonId={viewerId} />
        )}
      </main>
    </div>
  )
}
