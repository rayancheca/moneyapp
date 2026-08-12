import { Icon } from "@/components/shell/Icon";
import type { SectionNote } from "@/lib/section-notes";

/**
 * Measured guidance for a section — what the page knows that no single row can
 * say. A server component with no state and no model behind it: every figure in
 * a note was computed by the same services the rows were rendered from.
 *
 * Renders nothing when there is nothing measured to report, which is the point.
 * A guidance strip that always has something to say quickly becomes something
 * the reader stops seeing.
 */
export function SectionNotes({ notes, label }: { notes: readonly SectionNote[]; label: string }) {
  if (notes.length === 0) return null;
  return (
    <aside
      aria-label={label}
      className="rounded-(--radius-card) border border-line bg-surface-sunken/40 px-4 py-3"
    >
      <ul className="space-y-2">
        {notes.map((note) => (
          <li key={note.id} className="flex items-start gap-2 text-xs text-ink-muted">
            <Icon name="info" className="mt-0.5 size-3.5 shrink-0 text-ink-faint" aria-hidden />
            <span>{note.body}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
