"use client";

import { ErrorSurface, type RouteErrorProps } from "@/app/error";

export default function SettingsError({ error, reset }: RouteErrorProps) {
  return (
    <ErrorSurface
      error={error}
      reset={reset}
      headline="Settings didn't load."
      detail="A setting or rule that failed validation throws before it is stored, so the saved settings are still whatever they were — the message below says which value was rejected."
      back={{ href: "/settings", label: "Settings" }}
    />
  );
}
