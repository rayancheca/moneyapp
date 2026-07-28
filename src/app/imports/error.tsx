"use client";

import { ErrorSurface, type RouteErrorProps } from "@/app/error";

export default function ImportsError({ error, reset }: RouteErrorProps) {
  return (
    <ErrorSurface
      error={error}
      reset={reset}
      headline="The import surface didn't load."
      detail="A statement that a parser can't read throws here rather than importing half a file — the message below names what it choked on. Retry reloads the import list; already-imported statements are untouched."
      back={{ href: "/imports", label: "Imports" }}
    />
  );
}
