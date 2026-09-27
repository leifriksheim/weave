/**
 * @module doors
 * Doors and knocks — see `doors.ts`, and `node.doors` for the API an app uses.
 */
export {
  encodeDoorCode,
  parseDoorCode,
  checkDoorCode,
  doorTopic,
  knockId,
  sealKnock,
  openKnock,
  signPurge,
  purgeMessage,
  signAnswer,
  checkAnswer,
  clip,
  KNOCK_DROP_WINDOW_SECONDS,
  MAX_DOOR_RELAYS,
  KNOCK_TTL_SECONDS,
} from './doors.js';
export type { DoorCode, KnockBody, OpenedKnock } from './doors.js';
export { createMailboxClient } from '../network/mailbox.js';
export type { MailboxClient, MailboxOptions, MailItem } from '../network/mailbox.js';
