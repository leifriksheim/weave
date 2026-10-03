import {
  useLayoutEffect,
  type ComponentProps,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
} from 'react';
import { Avatar } from '@weave/app-shared/Avatar';
import { nameOf, type People } from '../../derive/people';
import { palette } from '../../styles';
import { Person } from '../Person';

/** How a mention stands out, in a message and in the box it is written in */
const MENTION_BG = '#e8f0fe';
const MENTION_INK = '#1a56c4';

/** A run of text, and whom it mentions when it is an "@Name" */
interface Segment {
  readonly text: string;
  readonly did?: string;
}

/** `text` cut around every "@Name" of someone in `named`, the longest name first so "@Ann Lee" beats "@Ann" */
function splitMentions(
  text: string,
  named: ReadonlyArray<{ readonly did: string; readonly name: string }>,
): Segment[] {
  const byName = new Map(named.map(({ did, name }) => [name.toLowerCase(), did]));
  if (!byName.size) return [{ text }];
  const names = [...byName.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const at = new RegExp(`(^|\\s)@(${names.join('|')})(?=$|[\\s.,!?:;)])`, 'gi');
  const segments: Segment[] = [];
  let from = 0;
  for (const match of text.matchAll(at)) {
    const start = match.index + (match[1]?.length ?? 0);
    const end = match.index + match[0].length;
    if (start > from) segments.push({ text: text.slice(from, start) });
    segments.push({ text: text.slice(start, end), did: byName.get((match[2] ?? '').toLowerCase()) });
    from = end;
  }
  if (from < text.length) segments.push({ text: text.slice(from) });
  return segments;
}

/** "@" in a text box: suggests the space's people as you type, and works out whom a sent text mentions. */
export function useMentions(options: {
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  readonly people: People;
  /** Every member, by DID: those with no name here are offered too, by the tail of their DID */
  readonly members?: ReadonlyArray<string>;
  /** You: never suggested, never mentioned */
  readonly me: string | null;
  readonly input: RefObject<HTMLInputElement | null>;
}) {
  const { draft, setDraft, people, members = [], me, input } = options;
  const everyone = [...new Set([...people.keys(), ...members])]
    .filter((did) => did !== me)
    .map((did) => ({ did, name: nameOf(did, people) }));
  const picked = useRef(new Map<string, string>());
  const [caret, setCaret] = useState(0);
  const [choice, setChoice] = useState(0);
  const typed = /(?:^|\s)@([^\s@]*)$/.exec(draft.slice(0, caret));
  const query = typed ? (typed[1] ?? '').toLowerCase() : null;
  const suggestions =
    query === null ? [] : everyone.filter((person) => person.name.toLowerCase().includes(query)).slice(0, 6);

  // Straight after the new text is in the box, before the next key lands: later, and it lands in the wrong place.
  const placeCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = placeCaret.current;
    if (at === null) return;
    placeCaret.current = null;
    input.current?.focus();
    input.current?.setSelectionRange(at, at);
  }, [draft, input]);

  const pick = (did: string) => {
    const label = nameOf(did, people);
    const before = draft.slice(0, caret).replace(/@[^\s@]*$/, `@${label} `);
    picked.current.set(label, did);
    setDraft(before + draft.slice(caret));
    setChoice(0);
    setCaret(before.length);
    placeCaret.current = before.length;
  };

  return {
    suggestions,
    choice,
    pick,
    /** For the box's `onChange` */
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      setDraft(e.target.value);
      setCaret(e.target.selectionStart ?? e.target.value.length);
      setChoice(0);
    },
    /** For the box's `onSelect` */
    onSelect: (e: SyntheticEvent<HTMLInputElement>) =>
      setCaret(e.currentTarget.selectionStart ?? draft.length),
    /** For the box's `onKeyDown`: moves through the suggestions and picks one. True when it used the key. */
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>): boolean => {
      if (!suggestions.length) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setChoice((i) => (i + step + suggestions.length) % suggestions.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const person = suggestions[choice] ?? suggestions[0];
        if (person) pick(person.did);
      } else if (e.key === 'Escape') {
        setCaret(0);
      }
      return true;
    },
    /** Whom `text` mentions, each once; and forgets what was picked, ready for the next draft */
    take: (text: string): string[] => {
      const named = [...[...picked.current].map(([name, did]) => ({ did, name })), ...everyone];
      const mentions = [
        ...new Set(splitMentions(text, named).flatMap((segment) => (segment.did ? [segment.did] : []))),
      ];
      picked.current.clear();
      return mentions;
    },
    /** The draft cut around its mentions, for `MentionField` to highlight */
    marked: splitMentions(draft, everyone),
  };
}

/** The people "@" suggests, under the box */
export function MentionList({
  suggestions,
  choice,
  people,
  onPick,
  style,
}: {
  suggestions: ReadonlyArray<{ readonly did: string }>;
  choice: number;
  people: People;
  onPick: (did: string) => void;
  style?: CSSProperties;
}) {
  if (!suggestions.length) return null;
  return (
    <div role="listbox" aria-label="Mention someone" style={style}>
      {suggestions.map((person, i) => (
        <button
          key={person.did}
          type="button"
          role="option"
          aria-selected={i === choice}
          // Keep the cursor in the box.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(person.did)}
          data-menu-item
          style={{
            width: '100%',
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            padding: '8px 12px',
            border: 'none',
            background: i === choice ? palette.surface.sunken : palette.surface.card,
            font: 'inherit',
            fontSize: 13,
            textAlign: 'left',
          }}
        >
          <Avatar did={person.did} size={20} />
          <span style={{ color: palette.ink.strong }}>{nameOf(person.did, people)}</span>
        </button>
      ))}
    </div>
  );
}

/** What a message or comment says, each "@Name" it mentions highlighted, opening their card */
export function MentionText({
  text,
  mentions,
  people,
}: {
  text: string;
  mentions: ReadonlyArray<string> | undefined;
  people: People;
}) {
  if (!mentions?.length) return text;
  const named = mentions.map((did) => ({ did, name: nameOf(did, people) }));
  return splitMentions(text, named).map((segment, i) =>
    segment.did ? (
      <Person
        key={i}
        did={segment.did}
        label={segment.text}
        style={{
          color: MENTION_INK,
          background: MENTION_BG,
          borderRadius: 4,
          padding: '0 2px',
          fontWeight: 500,
          textDecoration: 'none',
        }}
      />
    ) : (
      segment.text
    ),
  );
}

/**
 * A text box that highlights whom its draft mentions: a see-through field over
 * a copy of the draft whose text is invisible but whose mentions are tinted,
 * kept scrolled with the field.
 */
export function MentionField({
  marked,
  input,
  style,
  ...props
}: Omit<ComponentProps<'input'>, 'ref'> & {
  marked: ReadonlyArray<Segment>;
  input: RefObject<HTMLInputElement | null>;
}) {
  const under = useRef<HTMLDivElement>(null);
  const follow = () => {
    if (under.current && input.current) under.current.scrollLeft = input.current.scrollLeft;
  };
  useLayoutEffect(follow);
  return (
    <div
      style={{
        position: 'relative',
        flex: 1,
        minWidth: 0,
        borderRadius: 6,
        background: palette.surface.card,
      }}
    >
      <div
        ref={under}
        aria-hidden
        className="mention-layer"
        style={{
          position: 'absolute',
          inset: 0,
          padding: '0 12px',
          border: '1px solid transparent',
          fontSize: 14,
          lineHeight: '38px',
          whiteSpace: 'pre',
          overflow: 'hidden',
          color: 'transparent',
          pointerEvents: 'none',
        }}
      >
        {marked.map((segment, i) =>
          segment.did ? (
            <mark
              key={i}
              style={{
                color: 'transparent',
                background: MENTION_BG,
                borderRadius: 3,
                boxShadow: `0 0 0 2px ${MENTION_BG}`,
              }}
            >
              {segment.text}
            </mark>
          ) : (
            segment.text
          ),
        )}
      </div>
      <input
        {...props}
        ref={input}
        onScroll={follow}
        className="mention-layer"
        style={{ ...style, position: 'relative', width: '100%', backgroundColor: 'transparent' }}
      />
    </div>
  );
}
