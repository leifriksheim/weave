/**
 * @module records/describe
 * What a collection allows, in plain sentences — worked out from its rules,
 * never taken from what anyone says about it.
 *
 * A definition's title and description are the author's words, and an agent
 * can write anything there: "a friendly poll" whose rules let anyone delete
 * anyone's vote. These sentences come from the rules every peer enforces, so
 * a person deciding whether to add a collection reads what it will actually
 * do.
 *
 * Every rule must say something. A rule this module doesn't know makes it
 * throw rather than fall silent — a summary that leaves out a rule is the
 * lie it exists to prevent.
 */
import type { CollectionRules, Who } from './rules.js';
import type { LinkDeclaration } from './links.js';

/** As much of a definition as a summary reads */
export interface Describable {
  readonly name: string;
  readonly title?: string;
  /** Plain JSON Schema; field titles are used when it has them */
  readonly schema?: unknown;
  readonly history?: 'latest' | 'all';
  readonly links?: Readonly<Record<string, LinkDeclaration>>;
  readonly permissions?: ReadonlyArray<string>;
  readonly rules?: CollectionRules;
}

/** Every rule there is. A new one in `CollectionRules` must be added here, with its sentence. */
const KNOWN_RULES = ['create', 'edit', 'delete', 'onePer', 'fixed'] as const;

/** `closePolls` → `close polls`, `app.carpool.trip` → `trip` */
const words = (name: string) =>
  name
    .replace(/^.*\./, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();

const article = (noun: string) => (/^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function joinOr(parts: ReadonlyArray<string>): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}`;
}

function joinAnd(parts: ReadonlyArray<string>): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

const listOf = (who: Who | ReadonlyArray<Who> | undefined): ReadonlyArray<Who> =>
  who === undefined ? ['member'] : Array.isArray(who) ? who : [who as Who];

/** A field's label: its schema title, else its name in words */
function fieldLabel(schema: unknown, field: string): string {
  const properties = (schema as { properties?: Record<string, { title?: unknown }> } | null)?.properties;
  const title = properties?.[field]?.title;
  return typeof title === 'string' && title.trim() ? title.trim().toLowerCase() : words(field);
}

/** What a link role points at, in words: "trip" when it names one collection, else the role's own name */
function linkTarget(definition: Describable, rel: string): string {
  const to = definition.links?.[rel]?.to;
  return Array.isArray(to) && to.length === 1 ? words(to[0]!) : words(rel);
}

/**
 * The collection's rules, links and history as short sentences, in a fixed
 * order: who may add, who may change or remove, what must be unique, what
 * can't change, what it points at, which permissions roles can hold, and
 * whether old versions are kept.
 *
 * @throws When the rules hold something this doesn't know how to say
 */
export function describeCollection(definition: Describable): ReadonlyArray<string> {
  const rules = definition.rules ?? {};
  const unknown = Object.keys(rules).find((key) => !(KNOWN_RULES as ReadonlyArray<string>).includes(key));
  if (unknown) throw new Error(`No way to describe the rule "${unknown}" — add it to records/describe.ts`);

  const noun = (definition.title?.trim() || words(definition.name)).toLowerCase();
  const a = article(noun);
  const sentences: string[] = [];

  /** "anyone in the space", "whoever added it", "those allowed to moderate" */
  const who = (list: ReadonlyArray<Who>): { text: string; open: boolean } => {
    const parts = list.map((w) =>
      w === 'member' ? 'anyone in the space' : w === 'creator' ? `whoever added ${a}` : `those allowed to ${words(w.slice(4))}`,
    );
    return { text: joinOr(parts), open: list.includes('member') };
  };

  // Adding
  const create = who(listOf(rules.create));
  sentences.push(`${capital(create.open ? create.text : `only ${create.text}`)} can add ${a}.`);

  // Changing and removing — one sentence when the same people may do both
  const editors = listOf(rules.edit);
  const removers = rules.delete === undefined ? editors : listOf(rules.delete);
  const same = editors.length === removers.length && editors.every((w) => removers.includes(w));
  const action = (list: ReadonlyArray<Who>, verb: string) => {
    const { text, open } = who(list);
    const object = list.includes('creator') ? 'it' : `any ${noun}`;
    return `${capital(open ? text : `only ${text}`)} can ${verb} ${object}.`;
  };
  if (same) sentences.push(action(editors, 'change or remove'));
  else sentences.push(action(editors, 'change'), action(removers, 'remove'));

  // One per…
  if (rules.onePer?.length) {
    const per = rules.onePer.map((part) =>
      part === '@author' ? 'person' : part.startsWith('link:') ? linkTarget(definition, part.slice(5)) : fieldLabel(definition.schema, part),
    );
    sentences.push(`One ${noun} per ${per.join(' per ')} — adding another changes the first.`);
  }

  // Fixed fields
  if (rules.fixed?.length) {
    const fields = rules.fixed.map((field) => `“${fieldLabel(definition.schema, field)}”`);
    sentences.push(`Once ${a} is added, its ${joinAnd(fields)} can't be changed.`);
  }

  // What it points at
  for (const [rel, link] of Object.entries(definition.links ?? {})) {
    const target =
      link.to === '*' ? 'anything in the space' : joinOr(link.to.map((to) => article(words(to))));
    // The link's own name only when it says something the target doesn't: "about", not "trip" → a trip.
    const named = Array.isArray(link.to) && link.to.length === 1 && words(link.to[0]!) === words(rel) ? '' : ` (“${rel}”)`;
    sentences.push(
      link.cardinality === 'one' ? `Each ${noun} points at one thing: ${target}${named}.` : `${capital(a)} can point at ${target}${named}.`,
    );
  }

  // Permissions a role can be given
  if (definition.permissions?.length) {
    const list = joinAnd(definition.permissions.map((permission) => `“${words(permission)}”`));
    sentences.push(`Roles in the space can be given permission to ${list}.`);
  }

  if (definition.history === 'all') sentences.push(`Every earlier version of ${a} is kept.`);

  return sentences;
}
