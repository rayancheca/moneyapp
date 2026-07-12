"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createInstitutionAction } from "@/app/accounts/actions";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";

/**
 * Inline "add institution" (ux-overhaul-plan §7.2): a new bank without leaving
 * the page — it appears immediately in every institution picker after the
 * server revalidates. Find-or-create, so a duplicate name is a no-op, not an error.
 */
export function AddInstitution() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");

  function add(): void {
    const trimmed = name.trim();
    if (trimmed === "") return;
    void createInstitutionAction(trimmed).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      toast({ title: `Added ${trimmed}` });
      setName("");
      startTransition(() => router.refresh());
    });
  }

  return (
    <div className="flex items-end gap-2">
      <Field label="New institution" className="flex-1">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ally, Fidelity…"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
      </Field>
      <Button onClick={add} pending={pending} icon="plus">
        Add
      </Button>
    </div>
  );
}
