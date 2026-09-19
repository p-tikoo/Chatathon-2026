import React, { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useStore } from '../lib/store.jsx'
import { SPECIALTIES } from '../lib/seed.js'
import { HOUR, atHour, startOfDay } from '../lib/time.js'
import { Button, Field, Input, Panel, PanelHeader, Select } from '../components/ui.jsx'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const SHIFTS = {
  off: { label: 'Not working', blocks: [] },
  day: { label: 'Day list, 07:00-17:00', blocks: [[7, 17, 'Operating list']] },
  late: { label: 'Late list, 12:00-22:00', blocks: [[12, 22, 'Operating list']] },
  night: { label: 'Night, 19:00-07:00', blocks: [[19, 31, 'Night shift']] },
  call: {
    label: 'Day list then on call',
    blocks: [
      [7, 17, 'Operating list'],
      [17, 31, 'On call'],
    ],
  },
}

function Section({ title, description, children }) {
  return (
    <section className="border-t border-line px-4 py-4 first:border-t-0">
      <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
      {description ? (
        <p className="mt-0.5 max-w-[60ch] text-[13px] text-ink-3">{description}</p>
      ) : null}
      <div className="mt-3">{children}</div>
    </section>
  )
}

/** Turn the weekly pattern into concrete duty blocks across the model window. */
function buildDuty(pattern, now) {
  const today = startOfDay(now)
  const duty = []
  for (let d = -7; d <= 2; d++) {
    const dayStart = today + d * 24 * HOUR
    const weekday = new Date(dayStart).getDay()
    const shift = SHIFTS[pattern[weekday]] ?? SHIFTS.off
    for (const [from, to, kind] of shift.blocks) {
      duty.push({ start: atHour(dayStart, from), end: atHour(dayStart, to), kind })
    }
  }
  return duty
}

function buildCommitments(rows, now) {
  const today = startOfDay(now)
  const out = []
  for (const row of rows) {
    if (!row.label.trim()) continue
    for (let d = -7; d <= 2; d++) {
      const dayStart = today + d * 24 * HOUR
      if (new Date(dayStart).getDay() !== Number(row.day)) continue
      const from = Number(row.from)
      const to = Number(row.to)
      if (!(to > from)) continue
      out.push({
        label: row.label.trim(),
        start: atHour(dayStart, from),
        end: atHour(dayStart, to),
      })
    }
  }
  return out
}

export default function RegisterView({ onRegistered }) {
  const store = useStore()
  const { now } = store

  const [name, setName] = useState('')
  const [specialty, setSpecialty] = useState(SPECIALTIES[0])
  const [role, setRole] = useState('Attending')
  const [chronotype, setChronotype] = useState('neutral')
  const [bedHour, setBedHour] = useState('23:00')
  const [wakeHour, setWakeHour] = useState('07:00')
  const [commuteMin, setCommuteMin] = useState('25')
  const [maxContinuous, setMaxContinuous] = useState('14')
  const [callable, setCallable] = useState(true)
  const [caregiving, setCaregiving] = useState('')
  const [pattern, setPattern] = useState(['off', 'day', 'day', 'day', 'day', 'day', 'off'])
  const [commitments, setCommitments] = useState([
    { label: '', day: '1', from: '13', to: '17' },
  ])
  const [busy, setBusy] = useState(false)

  const toHour = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number)
    return h + (m || 0) / 60
  }

  const valid = name.trim().length > 1 && bedHour && wakeHour

  async function submit(e) {
    e.preventDefault()
    if (!valid) return
    setBusy(true)
    try {
      const { surgeon } = await store.register({
        name: name.trim(),
        specialty,
        role,
        chronotype,
        habitualSleep: { bedHour: toHour(bedHour), wakeHour: toHour(wakeHour) },
        commuteMinutes: Number(commuteMin) || 0,
        maxContinuousHours: Number(maxContinuous) || 14,
        callable,
        caregiving: caregiving.trim() || null,
        weeklyPattern: pattern,
        duty: buildDuty(pattern, now),
        commitments: buildCommitments(commitments, now),
        sleepLog: [],
        flags: [],
        registered: true,
      })
      if (surgeon) onRegistered?.(surgeon.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-[840px]">
      <Panel>
        <PanelHeader
          title="Surgeon registration"
          meta="Sets the baseline the fatigue model works from. You can change any of it later."
        />

        <form onSubmit={submit}>
          <Section title="Who you are">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Full name" htmlFor="reg-name">
                <Input
                  id="reg-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Priya Raman"
                  required
                />
              </Field>
              <Field label="Specialty" htmlFor="reg-specialty">
                <Select
                  id="reg-specialty"
                  value={specialty}
                  onChange={(e) => setSpecialty(e.target.value)}
                >
                  {SPECIALTIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Grade" htmlFor="reg-role">
                <Select id="reg-role" value={role} onChange={(e) => setRole(e.target.value)}>
                  <option>Attending</option>
                  <option>Fellow</option>
                  <option>Resident</option>
                </Select>
              </Field>
            </div>
          </Section>

          <Section
            title="Sleep"
            description="The model assumes you hit this window on any night it has no recorded sleep for, so a realistic answer matters more than an ideal one."
          >
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Usual bedtime" htmlFor="reg-bed">
                <Input
                  id="reg-bed"
                  type="time"
                  value={bedHour}
                  onChange={(e) => setBedHour(e.target.value)}
                  required
                />
              </Field>
              <Field label="Usual wake time" htmlFor="reg-wake">
                <Input
                  id="reg-wake"
                  type="time"
                  value={wakeHour}
                  onChange={(e) => setWakeHour(e.target.value)}
                  required
                />
              </Field>
              <Field label="Chronotype" htmlFor="reg-chrono" hint="Shifts your circadian peak">
                <Select
                  id="reg-chrono"
                  value={chronotype}
                  onChange={(e) => setChronotype(e.target.value)}
                >
                  <option value="early">Morning type</option>
                  <option value="neutral">Neither</option>
                  <option value="late">Evening type</option>
                </Select>
              </Field>
              <Field label="Commute, each way" htmlFor="reg-commute" hint="Minutes">
                <Input
                  id="reg-commute"
                  type="number"
                  min="0"
                  max="180"
                  value={commuteMin}
                  onChange={(e) => setCommuteMin(e.target.value)}
                />
              </Field>
            </div>
          </Section>

          <Section
            title="Working pattern"
            description="Your standing weekly roster. Actual assigned cases come from the OR schedule on top of this."
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {DAYS.map((day, i) => (
                <Field key={day} label={day} htmlFor={`reg-day-${i}`}>
                  <Select
                    id={`reg-day-${i}`}
                    value={pattern[i]}
                    onChange={(e) => {
                      const next = [...pattern]
                      next[i] = e.target.value
                      setPattern(next)
                    }}
                  >
                    {Object.entries(SHIFTS).map(([key, s]) => (
                      <option key={key} value={key}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
          </Section>

          <Section
            title="Other commitments"
            description="Clinics, teaching, research, anything that occupies you outside the operating schedule. These block assignments and count against recovery time."
          >
            <div className="grid gap-2">
              {commitments.map((row, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_130px_84px_84px_auto] items-end gap-2"
                >
                  <Field label={i === 0 ? 'What' : ''} htmlFor={`com-label-${i}`}>
                    <Input
                      id={`com-label-${i}`}
                      value={row.label}
                      placeholder="Outpatient clinic"
                      onChange={(e) => {
                        const next = [...commitments]
                        next[i] = { ...row, label: e.target.value }
                        setCommitments(next)
                      }}
                    />
                  </Field>
                  <Field label={i === 0 ? 'Day' : ''} htmlFor={`com-day-${i}`}>
                    <Select
                      id={`com-day-${i}`}
                      value={row.day}
                      onChange={(e) => {
                        const next = [...commitments]
                        next[i] = { ...row, day: e.target.value }
                        setCommitments(next)
                      }}
                    >
                      {DAYS.map((d, di) => (
                        <option key={d} value={di}>
                          {d}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={i === 0 ? 'From' : ''} htmlFor={`com-from-${i}`}>
                    <Input
                      id={`com-from-${i}`}
                      type="number"
                      min="0"
                      max="23"
                      value={row.from}
                      onChange={(e) => {
                        const next = [...commitments]
                        next[i] = { ...row, from: e.target.value }
                        setCommitments(next)
                      }}
                    />
                  </Field>
                  <Field label={i === 0 ? 'To' : ''} htmlFor={`com-to-${i}`}>
                    <Input
                      id={`com-to-${i}`}
                      type="number"
                      min="1"
                      max="24"
                      value={row.to}
                      onChange={(e) => {
                        const next = [...commitments]
                        next[i] = { ...row, to: e.target.value }
                        setCommitments(next)
                      }}
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="quiet"
                    aria-label={`Remove commitment ${i + 1}`}
                    onClick={() => setCommitments(commitments.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              className="mt-2"
              onClick={() =>
                setCommitments([...commitments, { label: '', day: '1', from: '13', to: '17' }])
              }
            >
              <Plus size={13} aria-hidden="true" />
              Add commitment
            </Button>
          </Section>

          <Section title="Limits">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field
                label="Maximum continuous duty"
                htmlFor="reg-max"
                hint="Hours. The scheduler treats this as a hard stop."
              >
                <Input
                  id="reg-max"
                  type="number"
                  min="6"
                  max="24"
                  value={maxContinuous}
                  onChange={(e) => setMaxContinuous(e.target.value)}
                />
              </Field>
              <Field
                label="Caregiving or other demands"
                htmlFor="reg-care"
                hint="Optional. Affects recovery time between shifts."
              >
                <Input
                  id="reg-care"
                  value={caregiving}
                  onChange={(e) => setCaregiving(e.target.value)}
                  placeholder="Young child, wakes around 05:30"
                />
              </Field>
              <Field label="Call-in" htmlFor="reg-callable">
                <label className="flex items-center gap-2 py-2 text-[13px] text-ink-2">
                  <input
                    id="reg-callable"
                    type="checkbox"
                    checked={callable}
                    onChange={(e) => setCallable(e.target.checked)}
                    className="size-4 accent-[var(--color-accent)]"
                  />
                  Available to be called in when off duty
                </label>
              </Field>
            </div>
          </Section>

          <div className="flex items-center gap-3 border-t border-line px-4 py-4">
            <Button type="submit" variant="primary" disabled={!valid || busy}>
              {busy ? 'Creating' : 'Create profile'}
            </Button>
            <p className="text-[13px] text-ink-3">
              You will be switched to your own view once the profile exists.
            </p>
          </div>
        </form>
      </Panel>
    </div>
  )
}
