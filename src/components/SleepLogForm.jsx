import React, { useState } from 'react'
import { HOUR, atHour, startOfDay, fmtDuration } from '../lib/time.js'
import { Button, Field, Input, Select } from './ui.jsx'

function toLocalInput(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Default to the surgeon's habitual window on the night just gone. */
function defaultWindow(surgeon, now) {
  const { bedHour, wakeHour } = surgeon.habitualSleep ?? { bedHour: 23, wakeHour: 7 }
  const duration = (wakeHour - bedHour + 24) % 24 || 7.5
  let start = atHour(startOfDay(now) - 24 * HOUR, bedHour)
  while (start + duration * HOUR < now - 24 * HOUR) start += 24 * HOUR
  return { start, end: start + duration * HOUR }
}

export default function SleepLogForm({ surgeon, now, onSubmit }) {
  const initial = defaultWindow(surgeon, now)
  const [start, setStart] = useState(toLocalInput(initial.start))
  const [end, setEnd] = useState(toLocalInput(initial.end))
  const [quality, setQuality] = useState('0.88')
  const [source, setSource] = useState('self-report')
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)

  const startMs = new Date(start).getTime()
  const endMs = new Date(end).getTime()
  const valid = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
  const hours = valid ? (endMs - startMs) / HOUR : 0
  const tooLong = hours > 16

  async function submit(e) {
    e.preventDefault()
    if (!valid || tooLong) return
    setBusy(true)
    try {
      await onSubmit({
        surgeonId: surgeon.id,
        start: startMs,
        end: endMs,
        quality: Number(quality),
        source,
      })
      setStatus(`Recorded ${fmtDuration(hours)} of sleep.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="px-4 py-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Fell asleep" htmlFor="sleep-start">
          <Input
            id="sleep-start"
            type="datetime-local"
            value={start}
            onChange={(e) => {
              setStart(e.target.value)
              setStatus(null)
            }}
            required
          />
        </Field>
        <Field label="Woke up" htmlFor="sleep-end">
          <Input
            id="sleep-end"
            type="datetime-local"
            value={end}
            onChange={(e) => {
              setEnd(e.target.value)
              setStatus(null)
            }}
            required
          />
        </Field>
        <Field label="Sleep quality" htmlFor="sleep-quality">
          <Select
            id="sleep-quality"
            value={quality}
            onChange={(e) => setQuality(e.target.value)}
          >
            <option value="0.95">Undisturbed</option>
            <option value="0.88">Good, woke once or twice</option>
            <option value="0.72">Broken</option>
            <option value="0.55">Very poor, on-call room</option>
          </Select>
        </Field>
        <Field label="Source" htmlFor="sleep-source">
          <Select id="sleep-source" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="self-report">Self-report</option>
            <option value="wearable">Wearable</option>
          </Select>
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={!valid || tooLong || busy}>
          {busy ? 'Saving' : 'Save sleep record'}
        </Button>
        <p className="text-[13px] text-ink-2" role="status">
          {!valid
            ? 'Wake time must be after the time you fell asleep.'
            : tooLong
              ? 'That is over 16 hours. Check the dates.'
              : (status ?? `${fmtDuration(hours)} in this record.`)}
        </p>
      </div>
    </form>
  )
}
