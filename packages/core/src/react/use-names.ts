import { useCallback } from 'react';
import { displayName } from '../space/names.js';
import { useProfiles } from './use-space.js';

/**
 * Names people in a space: `name(did)` is what they call themselves there,
 * with the tail of their identity added when two people gave the same name
 * (`displayName`), so a name can never pass for someone else's.
 */
export function useNames(spaceId: string): (did: string | null | undefined) => string {
  const profiles = useProfiles(spaceId);
  return useCallback((did) => displayName(did, profiles), [profiles]);
}
