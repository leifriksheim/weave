/**
 * @module schemas/standard
 * The standard library as one list, by area: what `collections_standard`
 * shows an agent, and what a `std.*` name means.
 */
import type { DefineCollection } from '../node/types.js';
import {
  reaction,
  comment,
  tag,
  attachment,
  reference,
  bookmark,
  rating,
  highlight,
  pin,
  report,
  label,
  claim,
} from './library/annotations.js';
import { profile, card, follow, block, mute, status } from './library/social.js';
import {
  message,
  channel,
  direct,
  post,
  repost,
  article,
  publication,
  doc,
  docBlock,
  wikiPage,
  note,
  call,
} from './library/publishing.js';
import { list, listItem, folder, file, photo, album, video, track, play } from './library/media.js';
import {
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
} from './library/planning.js';
import {
  place,
  visit,
  trip,
  location,
  recipe,
  meal,
  journalEntry,
  measurement,
  workout,
  work,
  progress,
} from './library/life.js';
import {
  expense,
  settlement,
  moneyAccount,
  transaction,
  listing,
  order,
  orderUpdate,
} from './library/money.js';
import {
  poll,
  vote,
  proposal,
  ballot,
  decision,
  goal,
  pledge,
  goalReached,
  announcement,
  badge,
  award,
  setting,
} from './library/community.js';
import { watch } from './library/agents.js';

type Definitions = ReadonlyArray<DefineCollection>;

/** Shapes that attach to anything */
export const standardAnnotations: Definitions = [
  reaction,
  comment,
  tag,
  attachment,
  reference,
  bookmark,
  rating,
  highlight,
  pin,
  report,
  label,
  claim,
];

/**
 * The library by area, in the order it is listed: what `collections_standard`
 * shows an agent, and Appendix A of the records spec.
 */
export const standardGroups: Readonly<Record<string, Definitions>> = Object.freeze({
  Annotations: standardAnnotations,
  People: [profile, card, follow, block, mute, status],
  'Messaging and publishing': [
    message,
    channel,
    direct,
    post,
    repost,
    article,
    publication,
    doc,
    docBlock,
    wikiPage,
    note,
    call,
  ],
  Lists: [list, listItem],
  'Files and media': [folder, file, photo, album, video, track, play],
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
  'Places and travel': [place, visit, trip, location],
  'Home and life': [recipe, meal, journalEntry, measurement, workout, work, progress],
  'Money and trade': [expense, settlement, moneyAccount, transaction, listing, order, orderUpdate],
  'Community and governance': [
    poll,
    vote,
    proposal,
    ballot,
    decision,
    goal,
    pledge,
    goalReached,
    announcement,
    badge,
    award,
  ],
  Settings: [setting],
  Agents: [watch],
});

/** Common nouns apps share: everything but the annotations */
export const standardNouns: Definitions = Object.values(standardGroups).slice(1).flat();
/** Everything in the library */
export const standardSchemas: Definitions = Object.values(standardGroups).flat();

/** The library's definition of a `std.*` name, or undefined when it has none */
export function standardDefinition(name: string): DefineCollection | undefined {
  return standardSchemas.find((definition) => definition.name === name);
}
