export function termLabel(code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return code ?? 'Unknown term'
  const year = Number(code.slice(0, 4))
  const season = { '10': 'Spring', '50': 'Summer', '90': 'Fall', '95': 'Winter' }[code.slice(4)]
  return season ? `${season} ${year}${code.endsWith('95') ? `–${year + 1}` : ''}` : code
}

export function observationTime(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return { label: 'Not recorded', note: 'Observation time unavailable.' }
  // API timestamps include an explicit zone; do not guess a zone for other data.
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value)
  const calendarValid = parts && Number(parts[2]) >= 1 && Number(parts[2]) <= 12 &&
    Number(parts[3]) >= 1 && Number(parts[3]) <= new Date(Date.UTC(Number(parts[1]), Number(parts[2]), 0)).getUTCDate() &&
    Number(parts[4]) < 24 && Number(parts[5]) < 60 && Number(parts[6]) < 60
  const milliseconds = calendarValid ? Date.parse(value) : NaN
  if (!Number.isFinite(milliseconds)) return { label: 'Unknown', note: 'Observation time unavailable.' }
  const date = new Date(milliseconds)
  const exact = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'long',
  }).format(date)
  const age = now - milliseconds
  let label = 'Just now'
  if (age < 0) label = 'Future timestamp'
  else if (age >= 86400000) {
    const days = Math.floor(age / 86400000)
    label = `${days} ${days === 1 ? 'day' : 'days'} ago`
  } else if (age >= 3600000) {
    const hours = Math.floor(age / 3600000)
    label = `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  } else if (age >= 60000) label = `${Math.floor(age / 60000)} min ago`
  return { label, exact, dateTime: date.toISOString(),
    note: age < 0 ? "Ahead of this device’s clock." : '' }
}
