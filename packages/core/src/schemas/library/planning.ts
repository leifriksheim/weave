/**
 * Time and planning: calendars, events and RSVPs, bookable slots, tasks on a
 * board, projects, time tracking, reminders, habits.
 */
import {
  about,
  authored,
  choice,
  count,
  day,
  markdown,
  one,
  own,
  people,
  placeRef,
  position,
  text,
  timeZone,
  typed,
  url,
  when,
  words,
  type Place,
} from '../fragments.js';

/** A calendar that events are `in`. */
export const calendar = typed<Calendar>()({
  name: 'std.calendar',
  title: 'Calendar',
  description: 'A calendar of events.',
  schema: {
    type: 'object',
    properties: { name: words(200), color: text(32) },
    required: ['name'],
  },
});
export interface Calendar {
  readonly name: string;
  readonly color?: string;
}

/**
 * Something happening at a time, after JSCalendar (RFC 8984). `start` and
 * `end` are RFC 3339 with `tz` saying where the times are meant, or whole days
 * (`YYYY-MM-DD`) with `allDay`. `rrule` repeats it (RFC 5545).
 */
export const event = typed<CalendarEvent>()({
  name: 'std.event',
  title: 'Event',
  description: 'Something happening at a time and place.',
  schema: {
    type: 'object',
    properties: {
      title: words(500),
      description: markdown(10000),
      start: when(),
      end: when(),
      tz: timeZone(),
      allDay: { type: 'boolean' },
      place: placeRef(),
      url: url(),
      rrule: text(1000, 'RFC 5545 recurrence rule, like "FREQ=WEEKLY;BYDAY=TU"', 1),
      status: choice(['confirmed', 'tentative', 'cancelled']),
    },
    required: ['title', 'start'],
  },
  links: { in: one(['std.calendar'], 'The calendar it is in') },
});
export interface CalendarEvent {
  readonly title: string;
  readonly description?: string;
  readonly start: string;
  readonly end?: string;
  readonly tz?: string;
  readonly allDay?: boolean;
  readonly place?: Place;
  readonly url?: string;
  readonly rrule?: string;
  readonly status?: 'confirmed' | 'tentative' | 'cancelled';
}

/** Whether someone is coming: one per person per event, changed by answering again. */
export const rsvp = typed<Rsvp>()({
  name: 'std.rsvp',
  title: 'RSVP',
  description: 'Whether someone is coming to an event: one answer per person.',
  schema: {
    type: 'object',
    properties: {
      status: choice(['going', 'maybe', 'no']),
      guests: count(0, 100, 'People they bring along'),
      note: text(500),
    },
    required: ['status'],
  },
  links: { about: one(['std.event'], 'The event') },
  rules: { ...own, onePer: ['@author', 'link:about'] },
});
export interface Rsvp {
  readonly status: 'going' | 'maybe' | 'no';
  readonly guests?: number;
  readonly note?: string;
}

/** A time that can be booked. Bookings are `about` it, one each. */
export const slot = typed<Slot>()({
  name: 'std.slot',
  title: 'Slot',
  description: 'A time that one person can book.',
  schema: {
    type: 'object',
    properties: { start: when(), end: when(), tz: timeZone(), note: text(1000) },
    required: ['start', 'end'],
  },
  links: { in: one(['std.calendar'], 'The calendar it is in') },
  permissions: ['moderate'],
  rules: authored,
});
export interface Slot {
  readonly start: string;
  readonly end: string;
  readonly tz?: string;
  readonly note?: string;
}

/** A booked slot. One per slot, so it can't be booked twice: whoever books first has it. */
export const booking = typed<Booking>()({
  name: 'std.booking',
  title: 'Booking',
  description: 'A booked slot: one booking per slot, first come.',
  schema: { type: 'object', properties: { note: text(1000) } },
  links: { about: one(['std.slot'], 'The slot booked') },
  permissions: ['moderate'],
  rules: { ...authored, onePer: ['link:about'] },
});
export interface Booking {
  readonly note?: string;
}

/** A column on a board — To do, Doing, Done — in the order it sits. */
export const column = typed<Column>()({
  name: 'std.column',
  title: 'Column',
  description: 'A column on a board, holding tasks.',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      position: { type: 'string', minLength: 1, maxLength: 200, description: 'Sorts where the column goes' },
    },
    required: ['name'],
  },
});
export interface Column {
  readonly name: string;
  readonly position?: string;
}

const TASK_STATUS = ['todo', 'doing', 'done', 'cancelled'] as const;

/**
 * A task: in a column of a board, under a parent task, in a project. `status`
 * is for lists without columns; a board's column says where the task is.
 * `assignees` is its topic, so "assigned to me" can be asked of a keeper that
 * can't read it.
 */
export const task = typed<Task>()({
  name: 'std.task',
  title: 'Task',
  description: 'A task, placed in a column.',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 500 },
      notes: { type: 'string', maxLength: 10000 },
      position: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Sorts where the task goes in its column',
      },
      due: when(),
      status: choice(TASK_STATUS),
      assignees: people(20, 'Who is doing it'),
      priority: count(0, 4, '0 none, 1 urgent, 2 high, 3 medium, 4 low'),
    },
    required: ['title'],
  },
  topics: ['assignees'],
  links: {
    column: { to: ['std.column'], cardinality: 'one', description: 'The column it sits in' },
    parent: one(['std.task'], 'The task it is part of'),
    project: one(['std.project'], 'The project it belongs to'),
  },
});
export interface Task {
  readonly title: string;
  readonly notes?: string;
  readonly position?: string;
  readonly due?: string;
  readonly status?: (typeof TASK_STATUS)[number];
  readonly assignees?: ReadonlyArray<string>;
  readonly priority?: number;
}

/** A project that tasks belong to. */
export const project = typed<Project>()({
  name: 'std.project',
  title: 'Project',
  description: 'A project that tasks belong to.',
  schema: {
    type: 'object',
    properties: {
      name: words(200),
      description: markdown(10000),
      status: choice(['planned', 'active', 'paused', 'done', 'cancelled']),
      due: when(),
    },
    required: ['name'],
  },
});
export interface Project {
  readonly name: string;
  readonly description?: string;
  readonly status?: 'planned' | 'active' | 'paused' | 'done' | 'cancelled';
  readonly due?: string;
}

/** Time spent on something; running while it has no `end`. */
export const timeEntry = typed<TimeEntry>()({
  name: 'std.time-entry',
  title: 'Time entry',
  description: 'Time someone spent on something.',
  schema: {
    type: 'object',
    properties: { start: when(), end: when(), note: text(1000) },
    required: ['start'],
  },
  links: { about: about('What the time was spent on') },
  rules: own,
});
export interface TimeEntry {
  readonly start: string;
  readonly end?: string;
  readonly note?: string;
}

/** A reminder for its author. Keep it in your own space. */
export const reminder = typed<Reminder>()({
  name: 'std.reminder',
  title: 'Reminder',
  description: 'Something to be reminded of at a time.',
  schema: {
    type: 'object',
    properties: { at: when(), note: text(1000), done: { type: 'boolean' } },
    required: ['at'],
  },
  links: { about: about('What it is about') },
  rules: own,
});
export interface Reminder {
  readonly at: string;
  readonly note?: string;
  readonly done?: boolean;
}

/** A habit to keep. Check-ins are `about` it. */
export const habit = typed<Habit>()({
  name: 'std.habit',
  title: 'Habit',
  description: 'Something to do regularly.',
  schema: {
    type: 'object',
    properties: {
      name: words(200),
      schedule: text(1000, 'RFC 5545 recurrence rule, like "FREQ=DAILY"'),
      target: { type: 'number', minimum: 0, description: 'How much a day counts as done' },
      unit: text(32),
      position: position(),
    },
    required: ['name'],
  },
  rules: own,
});
export interface Habit {
  readonly name: string;
  readonly schedule?: string;
  readonly target?: number;
  readonly unit?: string;
  readonly position?: string;
}

/** Doing a habit on a day: one per person per habit per day. */
export const checkin = typed<Checkin>()({
  name: 'std.checkin',
  title: 'Check-in',
  description: 'A habit done on a day: one per person per day.',
  schema: {
    type: 'object',
    properties: { date: day(), value: { type: 'number' }, note: text(1000) },
    required: ['date'],
  },
  links: { about: one(['std.habit'], 'The habit') },
  rules: { ...own, onePer: ['@author', 'link:about', 'date'] },
});
export interface Checkin {
  readonly date: string;
  readonly value?: number;
  readonly note?: string;
}
