import { useState, type Dispatch, type SetStateAction } from 'react';

/**
 * State that starts as a value and follows it when the value changes, so a
 * change shows at once and the next version to arrive replaces it. Followed
 * while rendering, not in an effect, so the old draft is never painted.
 */
export function useDraft<T>(value: T): [T, Dispatch<SetStateAction<T>>] {
  const [draft, setDraft] = useState(value);
  const [was, setWas] = useState(value);
  if (!Object.is(value, was)) {
    setWas(value);
    setDraft(value);
  }
  return [draft, setDraft];
}
