import React, { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { DAY, HOUR, MIN, fmtDayShort, fmtDuration, startOfDay } from '../lib/time.js'
import { Button, Field, Input, Segmented } from './ui.jsx'

const QUALITY = [
  { value: '0.95', label: 'Undisturbed' },
  { value: '0.88', label: 'Woke once' },
  { value: '0.72', label: 'Broken' },
  { value: '0.55', label: 'Barely slept' },
]

function pad(n) {
  return String(n).padStart(2, '0')
}

/** "23:00" from an hour float, for prefilling from a habitual bed/wake hour. */
function hourToTime(hour) {
  const h = Math.floor(hour) % 24
  const m = Math.round((hour - Math.floor(hour)) * 60)
  return `${pad(h)}:${pad(m)}`
}

/** Minutes past midnight from "HH:MM", or null if the field is incomplete. */
function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * HOUR + min * MIN
}

/**
 * The three most recent mornings. A night is identified by the morning it ends
 * on, which is how people date a night's sleep, and is what keeps the form down
 * to two clock times instead of two full datetimes.
 */
function recentNights(now, wakeHour) {
  const today = startOfDay(now)
  const lastMorning = now >= today + wakeHour * HOUR ? today : today - DAY
  return [0, 1, 2].map((i) => {
    const morning = lastMorning - i * DAY
    return {
      value: String(morning),
      label: i === 0 ? 'Last night' : `${fmtDayShort(morning - DAY)} night`,
    }
  })
}

export default function SleepLogForm({ surgeon, now, onSubmit }) {
  const habitual = surgeon.habitualSleep ?? { bedHour: 23, wakeHour: 7 }
  const nights = recentNights(now, habitual.wakeHour)

  const [night, setNight] = useState(nights[0].value)
  const [bed, setBed] = useState(hourToTime(habitual.bedHour))
  const [woke, setWoke] = useState(hourToTime(habitual.wakeHour))
  const [quality, setQuality] = useState('0.88')
  const [saved, setSaved] = useState(null)
  const [busy, setBusy] = useState(false)

  const bedOffset = parseTime(bed)
  const wokeOffset = parseTime(woke)

  let start = null
  let end = null
  if (bedOffset != null && wokeOffset != null) {
    const morning = Number(night)
    end = morning + wokeOffset
    start = morning + bedOffset
    // Anything at or after the wake time belongs to the evening before.
    if (start >= end) start -= DAY
  }

  const hours = start != null ? (end - start) / HOUR : 0
  const tooLong = hours > 16
  const valid = start != null && !tooLong

  function edit(setter) {
    return (e) => {
      setter(e.target.value)
      setSaved(null)
    }
  }

  async function submit(e) {
    e.preventDefault()
    if (!valid) return
    setBusy(true)
    try {
      await onSubmit({
        surgeonId: surgeon.id,
        start,
        end,
        quality: Number(quality),
        source: 'self-report',
      })
      setSaved(fmtDuration(hours))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 px-4 py-4">
      <Field label="Which night">
        <Segmented
          name="sleep-night"
          value={night}
          onChange={(v) => {
            setNight(v)
            setSaved(null)
          }}
          options={nights}
        />
      </Field>

      <div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <Field label="Asleep" htmlFor="sleep-bed">
            <Input
              id="sleep-bed"
              type="time"
              value={bed}
              onChange={edit(setBed)}
              required
              className="tnum"
            />
          </Field>
          <ArrowRight size={14} className="mb-2.5 text-ink-3" aria-hidden="true" />
          <Field label="Awake" htmlFor="sleep-woke">
            <Input
              id="sleep-woke"
              type="time"
              value={woke}
              onChange={edit(setWoke)}
              required
              className="tnum"
            />
          </Field>
        </div>
        <p className="mt-2 text-sm text-ink-2" role="status">
          {start == null ? (
            'Enter both times.'
          ) : tooLong ? (
            <span className="text-risk">Over 16 hours. Check the night and times.</span>
          ) : saved ? (
            `Saved ${saved}.`
          ) : (
            <>
              <span className="tnum font-medium text-ink">{fmtDuration(hours)}</span> in
              bed
            </>
          )}
        </p>
      </div>

      <Field label="How was it">
        <Segmented
          name="sleep-quality"
          value={quality}
          onChange={(v) => {
            setQuality(v)
            setSaved(null)
          }}
          options={QUALITY}
          columns={2}
        />
      </Field>

      <Button type="submit" variant="primary" disabled={!valid || busy}>
        {busy ? 'Saving' : 'Save sleep'}
      </Button>
    </form>
  )
}
