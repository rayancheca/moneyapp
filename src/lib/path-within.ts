import path from "node:path";

/**
 * `child` is `parent` or below it, compared by path components: data/statements-x is not inside data/statements, and
 * data/statements/.. is not either. Lexical — both are read from the working directory as written; a caller that must
 * see through a symlink compares real paths (scripts/statement-folders.ts).
 *
 * The folder itself needs no case of its own: `path.relative` gives "" for it, which no clause below refuses. An
 * absolute answer comes only from another drive on Windows — never on this Mac, so no test here can reach that clause.
 */
export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
