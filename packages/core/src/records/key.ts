/**
 * The shape of a record key, on its own so that `version` and `links` can both
 * check it without importing each other.
 */

/** Keys a caller may choose: `profile`, `collection:app.todo.item`, `space:b7…` */
export const RECORD_KEY_PATTERN = /^[a-z0-9:._-]{1,128}$/;
