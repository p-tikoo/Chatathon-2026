/**
 * Synthetic hospital dataset.
 *
 * Every surgeon, case, shift and sleep record in this file is fabricated for
 * demonstration. No real patient or staff data is used anywhere in this app.
 */

import { HOUR, startOfDay, atHour, overlaps } from './time.js'

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SPECIALTIES = [
  'Cardiothoracic',
  'Neurosurgery',
  'Orthopaedics',
  'General',
  'Vascular',
  'Trauma',
]

const PROCEDURES = {
  Cardiothoracic: [
    ['Coronary artery bypass graft', 300, 5],
    ['Aortic valve replacement', 270, 5],
    ['Mitral valve repair', 285, 5],
    ['Lobectomy', 210, 4],
    ['Pericardial window', 105, 3],
  ],
  Neurosurgery: [
    ['Craniotomy, tumour resection', 330, 5],
    ['Lumbar decompression', 165, 3],
    ['VP shunt revision', 120, 3],
    ['Aneurysm clipping', 315, 5],
    ['Burr hole evacuation', 90, 3],
  ],
  Orthopaedics: [
    ['Total knee arthroplasty', 120, 3],
    ['Total hip arthroplasty', 135, 3],
    ['ACL reconstruction', 105, 2],
    ['Ankle ORIF', 100, 3],
    ['Shoulder arthroscopy', 80, 2],
  ],
  General: [
    ['Laparoscopic cholecystectomy', 75, 2],
    ['Appendicectomy', 60, 2],
    ['Inguinal hernia repair', 70, 2],
    ['Right hemicolectomy', 180, 4],
    ['Laparotomy, small bowel obstruction', 150, 4],
  ],
  Vascular: [
    ['Femoral-popliteal bypass', 195, 4],
    ['Endovascular aneurysm repair', 165, 4],
    ['Carotid endarterectomy', 150, 4],
    ['AV fistula formation', 90, 2],
  ],
  Trauma: [
    ['Damage-control laparotomy', 135, 5],
    ['Femoral shaft nailing', 120, 3],
    ['Pelvic external fixation', 105, 4],
    ['Washout and debridement', 70, 2],
  ],
}

/**
 * `pattern` drives the generated duty roster:
 *   day       standard weekday operating list
 *   night     night float, 19:00-07:00
 *   postcall  night float whose last block ended this morning
 *   call      day list plus resident on-call nights
 *   light     reduced list, returning from leave
 */
const ROSTER = [
  ['s1', 'Amara Chen', 'Cardiothoracic', 'Attending', 'postcall', 'neutral', 23.0, 6.5],
  ['s2', 'Ravi Patel', 'General', 'Attending', 'day', 'early', 22.5, 6.0],
  ['s3', 'Lena Okafor', 'Neurosurgery', 'Attending', 'night', 'late', 9.5, 15.5],
  ['s4', 'Marcus Feld', 'Orthopaedics', 'Attending', 'day', 'neutral', 23.5, 7.0],
  ['s5', 'Sofia Marchetti', 'Vascular', 'Attending', 'call', 'late', 0.5, 7.5],
  ['s6', 'Daniel Boateng', 'General', 'Fellow', 'day', 'neutral', 23.0, 6.5],
  ['s7', 'Hana Ito', 'Trauma', 'Attending', 'night', 'late', 10.0, 16.0],
  ['s8', 'Peter Lindqvist', 'Cardiothoracic', 'Attending', 'day', 'early', 22.0, 5.5],
  ['s9', 'Nadia Rahman', 'Neurosurgery', 'Attending', 'light', 'neutral', 23.0, 7.0],
  ['s10', 'Tom Aleman', 'Orthopaedics', 'Fellow', 'call', 'neutral', 23.5, 6.5],
  ['s11', 'Grace Whitfield', 'General', 'Attending', 'day', 'early', 22.0, 5.5],
  ['s12', 'Yusuf Demir', 'Vascular', 'Fellow', 'day', 'neutral', 23.5, 7.0],
  ['s13', 'Clara Sandoval', 'Trauma', 'Attending', 'day', 'neutral', 23.0, 6.5],
  ['s14', 'Ben Osei', 'Orthopaedics', 'Attending', 'light', 'early', 22.5, 6.0],
  ['s15', 'Mei Lin Tan', 'Cardiothoracic', 'Fellow', 'call', 'late', 0.0, 7.5],
]

const ROOMS = ['OR 1', 'OR 2', 'OR 3', 'OR 4', 'OR 5', 'OR 6']

// --- Duty generation -------------------------------------------------------

function buildDuty(pattern, dayIndex, dayStart, rand) {
  const weekday = new Date(dayStart).getDay()
  const isWeekend = weekday === 0 || weekday === 6
  const blocks = []
  const add = (from, to, kind) =>
    blocks.push({ start: atHour(dayStart, from), end: atHour(dayStart, to), kind })

  switch (pattern) {
    case 'day':
      if (!isWeekend) add(7, 17, 'Operating list')
      break
    case 'night':
      // Night float runs a five-on block ending tomorrow morning.
      if (dayIndex >= -4) add(19, 31, 'Night float')
      break
    case 'postcall':
      // Three nights finishing this morning, then back on days from tomorrow.
      if (dayIndex >= -3 && dayIndex <= -1) add(19, 31, 'Night float')
      if (dayIndex >= 1 && !isWeekend) add(7, 15, 'Operating list')
      break
    case 'call':
      if (!isWeekend) add(7, 17, 'Operating list')
      if (dayIndex % 3 === 0) add(17, 31, 'On call, second cover')
      break
    case 'light':
      if (!isWeekend && rand() > 0.35) add(8, 14, 'Operating list')
      break
    default:
      break
  }
  return blocks
}

// --- Sleep generation ------------------------------------------------------

function buildSleep(surgeon, duty, dayStart, rand) {
  const { bedHour, wakeHour } = surgeon.habitualSleep
  const duration = (wakeHour - bedHour + 24) % 24 || 7.5

  const jitter = (spread) => (rand() - 0.5) * spread
  const candStart = atHour(dayStart, bedHour + jitter(1.2))
  const candEnd = candStart + (duration + jitter(1.4)) * HOUR

  const clash = duty.find((b) => overlaps(candStart, candEnd, b.start, b.end))

  // A few minutes of overrun into the next shift means getting up early, not
  // losing the night. Without this, jitter of six minutes displaces a whole
  // night's sleep by twelve hours.
  const overlapH = clash
    ? (Math.min(candEnd, clash.end) - Math.max(candStart, clash.start)) / HOUR
    : 0

  if (!clash || overlapH < 0.75) {
    const end = clash ? Math.min(candEnd, clash.start) : candEnd
    return {
      start: candStart,
      end,
      quality: 0.82 + rand() * 0.15,
      source: rand() > 0.3 ? 'wearable' : 'self-report',
    }
  }

  // Duty ate the habitual window. Sleep after the block instead, which is
  // shorter and, in daylight, less restorative.
  const start = clash.end + (0.6 + rand() * 0.8) * HOUR
  const end = start + (4.2 + rand() * 2.1) * HOUR
  return {
    start,
    end,
    quality: 0.6 + rand() * 0.14,
    source: rand() > 0.5 ? 'wearable' : 'self-report',
    displaced: true,
  }
}

// --- Cases -----------------------------------------------------------------

function buildCases(surgeons, now, rand) {
  const cases = []
  const today = startOfDay(now)
  let n = 1

  // A surgeon cannot be in two rooms at once. Without this the roster
  // double-books people constantly, and every such case then surfaces as a
  // reassignment for a reason that has nothing to do with fatigue.
  const booked = new Map()
  const isFree = (s, start, end) => {
    const held = booked.get(s.id) ?? []
    if (held.some(([a, b]) => overlaps(a, b, start, end))) return false
    return !(s.commitments ?? []).some((c) => overlaps(c.start, c.end, start, end))
  }
  const book = (s, start, end) => {
    booked.set(s.id, [...(booked.get(s.id) ?? []), [start, end]])
  }
  const pick = (specialty, start, end) => {
    const free = surgeons.filter((s) => s.specialty === specialty && isFree(s, start, end))
    if (!free.length) return null
    const chosen = free[Math.floor(rand() * free.length)]
    book(chosen, start, end)
    return chosen
  }

  for (let d = 0; d <= 2; d++) {
    const dayStart = today + d * 24 * HOUR
    for (const room of ROOMS) {
      let cursor = atHour(dayStart, 7.5 + rand() * 0.75)
      const listLength = 2 + Math.floor(rand() * 2)

      for (let i = 0; i < listLength; i++) {
        const specialty = SPECIALTIES[Math.floor(rand() * SPECIALTIES.length)]
        const options = PROCEDURES[specialty]
        const [name, baseMin, complexity] = options[Math.floor(rand() * options.length)]
        const durationMin = Math.round(baseMin * (0.85 + rand() * 0.35))
        const start = cursor
        const end = start + durationMin * 60 * 1000
        if (end > dayStart + 21 * HOUR) break

        const roll = rand()
        const acuity = roll > 0.88 ? 'emergent' : roll > 0.68 ? 'urgent' : 'elective'

        const assigned = pick(specialty, start, end)

        cases.push({
          id: `C-${String(n++).padStart(3, '0')}`,
          room,
          specialty,
          procedure: name,
          start,
          end,
          durationMin,
          complexity,
          acuity,
          surgeonId: assigned ? assigned.id : null,
        })

        cursor = end + (0.4 + rand() * 0.5) * HOUR
      }
    }
  }

  // A handful of overnight emergencies, so the night hours are not empty.
  for (let d = 0; d <= 1; d++) {
    const dayStart = today + d * 24 * HOUR
    const count = 2 + Math.floor(rand() * 2)
    for (let i = 0; i < count; i++) {
      const specialty = rand() > 0.5 ? 'Trauma' : 'General'
      const options = PROCEDURES[specialty]
      const [name, baseMin, complexity] = options[Math.floor(rand() * options.length)]
      const start = atHour(dayStart, 22 + rand() * 7)
      const durationMin = Math.round(baseMin * (0.8 + rand() * 0.3))
      const end = start + durationMin * 60 * 1000
      const assigned = pick(specialty, start, end)

      cases.push({
        id: `C-${String(n++).padStart(3, '0')}`,
        room: ROOMS[Math.floor(rand() * 2)],
        specialty,
        procedure: name,
        start,
        end,
        durationMin,
        complexity,
        acuity: 'emergent',
        surgeonId: assigned ? assigned.id : null,
      })
    }
  }

  return cases.sort((a, b) => a.start - b.start)
}

// --- Entry point -----------------------------------------------------------

export function buildDataset(now = Date.now()) {
  const rand = rng(20260919)
  const today = startOfDay(now)

  const surgeons = ROSTER.map(
    ([id, name, specialty, role, pattern, chronotype, bedHour, wakeHour]) => ({
      id,
      name,
      specialty,
      role,
      pattern,
      chronotype,
      habitualSleep: { bedHour, wakeHour },
      duty: [],
      sleepLog: [],
      commitments: [],
      flags: [],
      registered: true,
    })
  )

  for (const s of surgeons) {
    for (let d = -7; d <= 2; d++) {
      const dayStart = today + d * 24 * HOUR
      s.duty.push(...buildDuty(s.pattern, d, dayStart, rand))
    }
    for (let d = -7; d <= 0; d++) {
      const dayStart = today + d * 24 * HOUR
      // Keep the natural end even when it is in the future: a surgeon who is
      // mid-sleep right now should read as asleep, not as having woken this
      // instant and taken a full sleep-inertia penalty.
      const episode = buildSleep(s, s.duty, dayStart, rand)
      if (episode.start < now) s.sleepLog.push(episode)
    }
    s.sleepLog = s.sleepLog.filter((e) => e.end > e.start)
  }

  // Non-operating commitments that compete with rest.
  const commitments = [
    ['s2', 'Outpatient clinic', 1, 13, 17],
    ['s4', 'M&M meeting', 1, 7, 8],
    ['s5', 'Departmental teaching', 2, 8, 9.5],
    ['s6', 'Research supervision', 1, 17, 18.5],
    ['s9', 'Return-to-work review', 1, 9, 10],
    ['s11', 'Outpatient clinic', 2, 9, 13],
    ['s13', 'Trauma governance', 1, 16, 17.5],
  ]
  for (const [id, label, day, from, to] of commitments) {
    const s = surgeons.find((x) => x.id === id)
    if (!s) continue
    const dayStart = today + day * 24 * HOUR
    s.commitments.push({
      label,
      start: atHour(dayStart, from),
      end: atHour(dayStart, to),
    })
  }

  // One self-reported flag already in the system, so the director view has
  // something to respond to on load.
  surgeons
    .find((s) => s.id === 's3')
    .flags.push({
      at: now - 40 * 60 * 1000,
      reason: 'Fourth consecutive night. Not safe for a long elective case.',
      severity: 'stand-down',
    })

  const cases = buildCases(surgeons, now, rand)

  return { surgeons, cases, generatedAt: now }
}

export { SPECIALTIES }
