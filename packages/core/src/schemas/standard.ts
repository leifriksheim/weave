/**
 * The standard library as one list, by area: what `collections_standard`
 * shows an agent, and what a `std.*` name means.
 */
import type { DefineCollection } from '../node/types.js';
import { annotationGroups } from './library/annotations.js';
import { socialGroups } from './library/social.js';
import { publishingGroups } from './library/publishing.js';
import { mediaGroups } from './library/media.js';
import { planningGroups } from './library/planning.js';
import { lifeGroups } from './library/life.js';
import { moneyGroups } from './library/money.js';
import { communityGroups } from './library/community.js';
import { activity, rule, ruleRun } from '../schemas/rules.js';

type Definitions = ReadonlyArray<DefineCollection>;

/** Shapes that attach to anything */
export const standardAnnotations: Definitions = annotationGroups.Annotations;

/**
 * The library by area, in the order it is listed: what `collections_standard`
 * shows an agent, and Appendix A of the records spec.
 */
export const standardGroups: Readonly<Record<string, Definitions>> = Object.freeze({
  ...annotationGroups,
  ...socialGroups,
  ...publishingGroups,
  ...mediaGroups,
  ...planningGroups,
  ...lifeGroups,
  ...moneyGroups,
  ...communityGroups,
  Rules: [rule, ruleRun, activity],
});

/** Common nouns apps share: everything but the annotations */
export const standardNouns: Definitions = Object.values(standardGroups).slice(1).flat();
/** Everything in the library */
export const standardSchemas: Definitions = Object.values(standardGroups).flat();

/** The library's definition of a `std.*` name, or undefined when it has none */
export function standardDefinition(name: string): DefineCollection | undefined {
  return standardSchemas.find((definition) => definition.name === name);
}
