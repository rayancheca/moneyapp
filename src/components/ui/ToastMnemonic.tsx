"use client";

import { useKeyScope } from "@/components/ui/KeyScopeProvider";
import { focusNewestToastAction } from "@/components/ui/Toast";
import { PRIORITIES } from "@/lib/keyscope";

/**
 * The `A` mnemonic (ux-overhaul-plan §1.7/§3.4): moves focus to the newest
 * action toast's button, so a rule prompt ("Create rule → applies to N") — or
 * any action toast — is reachable mid-triage without a full-document Tab.
 * Registered app-wide at the toast tier (above modal sheets, below the palette),
 * a no-op when no action toast is showing. Typing `a` in a field is unaffected
 * (the KeyScope stack ignores plain mnemonics on editable targets).
 */
export function ToastMnemonic() {
  useKeyScope(
    "toast-mnemonic",
    {
      a: () => {
        focusNewestToastAction();
      },
    },
    true,
    { priority: PRIORITIES.toast },
  );
  return null;
}
