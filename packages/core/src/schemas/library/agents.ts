/**
 * What a person's own agent does without being asked each time.
 */
import { own, text, typed, words } from '../fragments.js';

/**
 * A watch: when records like `query` appear or change, or at the times
 * `every` names, the agent of the account that wrote it does what `do` says.
 *
 * A watch counts only as its account wrote it: an agent may write one when
 * asked, but it runs once the person has saved it themselves, so an agent
 * can suggest what it watches and never switch that on alone. Whoever
 * reads it: an agent program, or an app showing what an agent is watching.
 */
export const watch = typed<Watch>()({
  name: 'std.watch',
  title: 'Watch',
  description: "What a person's agent does when some records appear or change, or at set times.",
  schema: {
    type: 'object',
    properties: {
      name: words(200),
      query: {
        type: 'object',
        description:
          'Which records set it off: a query in the query format, its collection and where. "$me" in a value stands for the account.',
        properties: {
          collection: words(200),
          where: { type: 'object' },
        },
        required: ['collection'],
      },
      spaces: {
        type: 'array',
        maxItems: 64,
        items: text(256, 'A space id', 1),
        description: 'Only these spaces; every space the agent follows when left out',
      },
      every: text(
        100,
        'When it runs by itself: five cron fields, minute hour day month weekday, local time',
        9,
      ),
      do: words(10000),
      paused: { type: 'boolean' },
    },
    required: ['name', 'do'],
  },
  rules: own,
});
export interface Watch {
  readonly name: string;
  readonly query?: { readonly collection: string; readonly where?: Readonly<Record<string, unknown>> };
  readonly spaces?: ReadonlyArray<string>;
  readonly every?: string;
  /** What the agent does, in the person's words */
  readonly do: string;
  readonly paused?: boolean;
}
