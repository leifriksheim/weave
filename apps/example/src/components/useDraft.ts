import { useState, type Dispatch, type SetStateAction } from 'react';

/** State that follows a value when it changes, followed while rendering so an old draft never paints */
export function useDraft<T>(value: T): [T, Dispatch<SetStateAction<T>>] {
  const [draft, setDraft] = useState(value);
  const [was, setWas] = useState(value);
  if (!Object.is(value, was)) {
    setWas(value);
    setDraft(value);
  }
  return [draft, setDraft];
}
