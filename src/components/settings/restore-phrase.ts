/**
 * The gate in front of a restore.
 *
 * Every other destructive action in the app is a checkbox away (Confirm's
 * `acknowledgement`), because every other one is scoped — a rule, an import, a
 * category. A restore replaces the entire ledger, so it asks for a word to be
 * typed instead: a checkbox can be hit by the same reflex that opened the
 * dialog, a word cannot.
 *
 * Dependency-free on purpose. The dialog gates the button with it and the
 * server action re-checks it, from ONE definition — a gate enforced only in the
 * browser is decoration.
 */

export const RESTORE_PHRASE = "RESTORE";

/**
 * Case and surrounding whitespace are forgiven; nothing else is. Typing the
 * word in lower case is still six deliberate keystrokes, and refusing it would
 * only teach the owner to fight the box rather than read the dialog.
 */
export function matchesRestorePhrase(input: string): boolean {
  return input.trim().toUpperCase() === RESTORE_PHRASE;
}
