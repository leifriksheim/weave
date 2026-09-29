/**
 * Looks to ask an agent for when it makes an app. Every one keeps what makes
 * a screen at home in Weave (hairlines, whitespace, restraint, light and
 * dark), and then leans a way of its own. The words go into the prompt
 * `CreateApp` copies; a screen can load no fonts or images (`SCREEN_GUIDE`),
 * so everything here is CSS the agent can write inline.
 */

/** What every look shares, so a new app sits well beside Weave's own */
const BASE =
  'Make its screen look at home in the Weave app it opens in: a white page (near-black in dark mode, with prefers-color-scheme), ' +
  'near-black text, one grey for anything secondary, 1px hairline borders (#eaeaea, or #2a2a2a in dark) instead of heavy shadows, ' +
  'the system font stack (-apple-system, "Segoe UI", system-ui, sans-serif), 14px body text, spacing on a 4px grid, and plenty of room. ' +
  'Buttons and inputs are real elements, at least 36px tall, with a visible focus ring. Only one accent colour, used for the main action and what is selected.';

export interface Design {
  readonly id: string;
  readonly label: string;
  /** For the picker: the feel in a few words */
  readonly blurb: string;
  /** For the picker's swatch */
  readonly swatch: {
    readonly accent: string;
    readonly radius: number;
    readonly font: string;
    readonly weight: number;
  };
  /** What it adds to the prompt, after BASE */
  readonly ask: string;
}

export const DESIGNS: ReadonlyArray<Design> = [
  {
    id: 'neutral',
    label: 'Neutral',
    blurb: 'Like Weave itself',
    swatch: { accent: '#000000', radius: 6, font: 'inherit', weight: 600 },
    ask: 'Keep it neutral, like Weave itself: black is the accent, corners are 6–8px, and there is no decoration at all.',
  },
  {
    id: 'friendly',
    label: 'Friendly',
    blurb: 'Warm and soft',
    swatch: { accent: '#e8705a', radius: 12, font: 'inherit', weight: 600 },
    ask:
      'Make it warm and friendly: a soft coral accent (#e8705a), 12px rounded corners, gentle tinted backgrounds for highlights, ' +
      'short friendly labels, and an emoji where it truly helps, never more than one per section.',
  },
  {
    id: 'playful',
    label: 'Playful',
    blurb: 'Fun, a little quirky',
    swatch: { accent: '#7c3aed', radius: 16, font: 'inherit', weight: 800 },
    ask:
      'Make it playful and a little quirky: a bright violet accent (#7c3aed), chunky 14–16px corners, bold heavy headings, ' +
      'and small touches of delight: a springy transition on press, a sticker-like badge, a cheerful empty state. ' +
      'It must still be easy to read and use; delight goes in the details, not in the way.',
  },
  {
    id: 'professional',
    label: 'Professional',
    blurb: 'Calm and precise',
    swatch: { accent: '#335c99', radius: 4, font: 'inherit', weight: 500 },
    ask:
      'Make it calm and professional: dense but orderly, aligned columns and tabular numbers (font-variant-numeric: tabular-nums), ' +
      '4–6px corners, a muted blue accent (#335c99) used sparingly, small uppercase labels with letter spacing, and no emoji.',
  },
  {
    id: 'editorial',
    label: 'Editorial',
    blurb: 'Big type, lots of air',
    swatch: { accent: '#7a1f2b', radius: 2, font: 'Georgia, "Iowan Old Style", serif', weight: 600 },
    ask:
      'Make it editorial: large confident headings in a serif (Georgia, "Iowan Old Style", serif) with tight letter spacing, ' +
      'body text in the system sans, generous whitespace, near-square 2px corners, and a deep oxblood accent (#7a1f2b).',
  },
];

/** The sentences a look adds to the prompt */
export const designPrompt = (design: Design): string => `${BASE} ${design.ask}`;
