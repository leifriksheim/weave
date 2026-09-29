/**
 * Asking a person, when there is one to ask.
 *
 * At a terminal, what a command still needs is asked for: a list to pick
 * from, a yes or no, a secret typed unseen (`@clack/prompts`). Anywhere else
 * (an agent's shell, CI, a pipe) nothing is ever asked, since nobody would
 * answer and the command would hang: a missing value fails at once, naming
 * the flag that gives it. So every question here has a flag, and a person and
 * an agent reach the same result by different roads.
 *
 * Prompts draw on stderr, so stdout stays what a command printed as data.
 */
import * as clack from '@clack/prompts';

const io = { output: process.stderr };

/** Whether someone is there to answer: a terminal on both ends, and not CI */
export const interactive = (): boolean => !!process.stdin.isTTY && !!process.stderr.isTTY && !clack.isCI();

/** A value the command needs, asked for nowhere: which flag gives it, and where to look */
class Missing extends Error {
  constructor(flag: string, hint?: string) {
    super(`Missing --${flag}.${hint ? ` ${hint}` : ''}`);
  }
}

/** The end: Ctrl-C and Escape stop the command, having changed nothing */
function stop(): never {
  clack.cancel('Stopped. Nothing was changed.', io);
  process.exit(130);
}

export interface Ask {
  /** The flag that gives it without asking */
  readonly flag: string;
  readonly message: string;
  /** Where to find a value, said when there is nobody to ask */
  readonly hint?: string;
}

/** Some text: typed at a terminal, or `--<flag>` */
export async function text(
  ask: Ask & {
    readonly placeholder?: string;
    readonly initialValue?: string;
    readonly validate?: (value: string) => string | undefined;
  },
): Promise<string> {
  if (!interactive()) throw new Missing(ask.flag, ask.hint);
  const value = await clack.text({
    ...io,
    message: ask.message,
    ...(ask.placeholder ? { placeholder: ask.placeholder } : {}),
    ...(ask.initialValue ? { initialValue: ask.initialValue } : {}),
    validate: (value) => (value?.trim() ? ask.validate?.(value.trim()) : 'This one is needed'),
  });
  if (clack.isCancel(value)) stop();
  return value.trim();
}

/** One of some choices: picked with the arrow keys, or `--<flag> <value>` */
export async function select<V extends string>(
  ask: Ask & {
    readonly options: ReadonlyArray<{ readonly value: V; readonly label: string; readonly hint?: string }>;
    readonly initialValue?: V;
  },
): Promise<V> {
  if (!interactive()) throw new Missing(ask.flag, ask.hint);
  const value = await clack.select<string>({
    ...io,
    message: ask.message,
    options: ask.options.map(({ value, label, hint }) => ({ value, label, ...(hint ? { hint } : {}) })),
    ...(ask.initialValue ? { initialValue: ask.initialValue } : {}),
  });
  if (clack.isCancel(value)) stop();
  const picked = ask.options.find((option) => option.value === value);
  if (!picked) stop();
  return picked.value;
}

/**
 * Yes or no, before something that can't be undone. `--yes` says yes ahead
 * of time; with nobody to ask and no `--yes`, the answer is `otherwise`.
 */
export async function confirm(
  message: string,
  options: { readonly yes?: boolean; readonly otherwise: boolean },
): Promise<boolean> {
  if (options.yes) return true;
  if (!interactive()) return options.otherwise;
  const value = await clack.confirm({ ...io, message });
  if (clack.isCancel(value)) stop();
  return value;
}

/**
 * A secret, typed unseen: never a flag, which `ps` would show. With nobody to
 * ask it has to come from the environment, which `hint` names.
 */
export async function secret(message: string, hint: string): Promise<string> {
  if (!interactive()) throw new Error(`${message} There is no terminal to ask on: ${hint}.`);
  const value = await clack.password({
    ...io,
    message,
    validate: (value) => (value?.trim() ? undefined : 'This one is needed'),
  });
  if (clack.isCancel(value)) stop();
  return value.trim();
}

/** A heading, a note and a closing line for a flow, shown only to a person at a terminal */
export const intro = (title: string) => interactive() && clack.intro(title, io);
export const note = (message: string, title?: string) => interactive() && clack.note(message, title, io);
export const outro = (message: string) => interactive() && clack.outro(message, io);
