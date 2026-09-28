/** What went wrong, as a sentence to show */
export const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
