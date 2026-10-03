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
  define,
  url,
  when,
  words,
  person,
} from '../fragments.js';
import type { BodyOf } from '../../query/types.js';

/** A calendar that events are `in`. */
export const calendar = define({
  name: 'std.calendar',
  title: 'Calendar',
  description: 'A calendar of events.',
  schema: {
    type: 'object',
    properties: { name: words(200), color: text(32) },
    required: ['name'],
  },
});
export type Calendar = BodyOf<typeof calendar>;

/**
 * Something happening at a time, after JSCalendar (RFC 8984). `start` and
 * `end` are RFC 3339 with `tz` saying where the times are meant, or whole days
 * (`YYYY-MM-DD`) with `allDay`. `rrule` repeats it (RFC 5545).
 */
export const event = define({
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
export type CalendarEvent = BodyOf<typeof event>;

/** Whether someone is coming: one per person per event, changed by answering again. */
export const rsvp = define({
  name: 'std.rsvp',
  title: 'RSVP',
  description: 'Whether someone is coming to an event: one answer per person.',
  schema: {
    type: 'object',
    properties: {
      respondingTo: person('Whose record it responds to, so they can be told'),
      status: choice(['going', 'maybe', 'no']),
      guests: count(0, 100, 'People they bring along'),
      note: text(500),
    },
    required: ['status'],
  },
  links: { about: one(['std.event'], 'The event') },
  rules: { ...own, onePer: ['@author', 'link:about'] },
  topics: ['respondingTo'],
});
export type Rsvp = BodyOf<typeof rsvp>;

/** A time that can be booked. Bookings are `about` it, one each. */
export const slot = define({
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
export type Slot = BodyOf<typeof slot>;

/** A booked slot. One per slot, so it can't be booked twice: whoever books first has it. */
export const booking = define({
  name: 'std.booking',
  title: 'Booking',
  description: 'A booked slot: one booking per slot, first come.',
  schema: {
    type: 'object',
    properties: {
      respondingTo: person('Whose record it responds to, so they can be told'),
      note: text(1000),
    },
  },
  links: { about: one(['std.slot'], 'The slot booked') },
  permissions: ['moderate'],
  rules: { ...authored, onePer: ['link:about'] },
  topics: ['respondingTo'],
});
export type Booking = BodyOf<typeof booking>;

/** A column on a board — To do, Doing, Done — in the order it sits. */
export const column = define({
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
export type Column = BodyOf<typeof column>;

const TASK_STATUS = ['todo', 'doing', 'done', 'cancelled'] as const;

/**
 * A task: in a column of a board, under a parent task, in a project. `status`
 * is for lists without columns; a board's column says where the task is.
 * `assignees` is its topic, so "assigned to me" can be asked of a keeper that
 * can't read it.
 */
export const task = define({
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
export type Task = BodyOf<typeof task>;

/** A project that tasks belong to. */
export const project = define({
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
export type Project = BodyOf<typeof project>;

/** Time spent on something; running while it has no `end`. */
export const timeEntry = define({
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
export type TimeEntry = BodyOf<typeof timeEntry>;

/** A reminder for its author. Keep it in your own space. */
export const reminder = define({
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
export type Reminder = BodyOf<typeof reminder>;

/** A habit to keep. Check-ins are `about` it. */
export const habit = define({
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
export type Habit = BodyOf<typeof habit>;

/** Doing a habit on a day: one per person per habit per day. */
export const checkin = define({
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
export type Checkin = BodyOf<typeof checkin>;

/** This file's part of `standardGroups` */
export const planningGroups = {
  'Time and planning': [
    calendar,
    event,
    rsvp,
    slot,
    booking,
    column,
    task,
    project,
    timeEntry,
    reminder,
    habit,
    checkin,
  ],
};
