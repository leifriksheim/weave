import {
  useLayoutEffect,
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

/**
 * "@" in a text box: suggests the people of the space as you type after it,
 * and works out whom a text mentions when it is sent, for `mentions` on a
 * `std.message`, `std.comment` or `std.post`. A mention is whoever was picked
 * after "@", or whoever's full name was typed after one. Names are shown
 * unique (`nameOf`), so neither is a guess.
 */
export function useMentions(options: {
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  readonly people: People;
  /** You: never suggested, never mentioned */
  readonly me: string | null;
  readonly input: RefObject<HTMLInputElement | null>;
}) {
  const { draft, setDraft, people, me, input } = options;
  const picked = useRef(new Map<string, string>());
  const [caret, setCaret] = useState(0);
  const [choice, setChoice] = useState(0);
  const typed = /(?:^|\s)@([^\s@]*)$/.exec(draft.slice(0, caret));
  const query = typed ? (typed[1] ?? '').toLowerCase() : null;
  const suggestions =
    query === null
      ? []
      : [...people.values()]
          .filter((person) => person.did !== me && person.name.toLowerCase().includes(query))
          .slice(0, 6);

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
      const named = (label: string) =>
        new RegExp(`(?:^|\\s)@${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s.,!?:;)])`, 'i').test(
          text,
        );
      const typedNames = [...people.keys()]
        .filter((did) => did !== me)
        .map((did) => [nameOf(did, people), did] as const);
      const mentions = [
        ...new Set(
          [...picked.current, ...typedNames].filter(([label]) => named(label)).map(([, did]) => did),
        ),
      ];
      picked.current.clear();
      return mentions;
    },
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
