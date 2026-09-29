/**
 * When a rule runs by itself (`every`): five cron fields, minute hour day
 * month weekday, in the runner's local time.
 */

const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 7 },
] as const;

/** The values one cron field allows, or a reason it can't be read */
function cronField(text: string, min: number, max: number): Set<number> | string {
  const allowed = new Set<number>();
  for (const part of text.split(',')) {
    const found = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!found) return `"${part}" is not a number, a range, * or a step`;
    const [, all, from, to, step] = found;
    const start = all === '*' ? min : Number(from);
    const end = all === '*' ? max : to !== undefined ? Number(to) : step !== undefined ? max : start;
    const by = step !== undefined ? Number(step) : 1;
    if (start < min || end > max || start > end || by < 1) return `"${part}" is outside ${min}–${max}`;
    for (let value = start; value <= end; value += by) allowed.add(value);
  }
  return allowed;
}

/** Why a cron expression can't be read, or null */
export function checkCron(expression: string): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return 'A schedule is five fields: minute hour day month weekday';
  for (const [index, field] of CRON_FIELDS.entries()) {
    const read = cronField(parts[index] ?? '', field.min, field.max);
    if (typeof read === 'string') return `${field.name}: ${read}`;
  }
  return null;
}

/** Whether a cron expression names this minute, in local time. As in cron, a day and a weekday both given means either. */
export function cronMatches(expression: string, at: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const sets = CRON_FIELDS.map((field, index) => cronField(parts[index] ?? '', field.min, field.max));
  const [minute, hour, day, month, weekday] = sets;
  if (!(minute instanceof Set && hour instanceof Set && day instanceof Set && month instanceof Set))
    return false;
  if (!(weekday instanceof Set)) return false;
  if (weekday.has(7)) weekday.add(0);
  if (!minute.has(at.getMinutes()) || !hour.has(at.getHours()) || !month.has(at.getMonth() + 1)) return false;
  const anyDay = parts[2] === '*';
  const anyWeekday = parts[4] === '*';
  const onDay = day.has(at.getDate());
  const onWeekday = weekday.has(at.getDay());
  if (anyDay && anyWeekday) return true;
  if (anyDay) return onWeekday;
  if (anyWeekday) return onDay;
  return onDay || onWeekday;
}
