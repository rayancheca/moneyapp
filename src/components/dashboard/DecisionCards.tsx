"use client";

import { useCallback } from "react";
import { CardDeck, type DeckCard } from "@/components/dashboard/CardDeck";
import {
  DASHBOARD_SURFACE,
  DECISIONS_VIEW_LABELS,
  DECISIONS_VIEW_SPEC,
} from "@/components/dashboard/dashboard-view-spec";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import { useViewState } from "@/hooks/useViewState";
import type { ViewState } from "@/lib/view-state";

const CARDS_DIMENSION = DECISIONS_VIEW_SPEC[0]!;
/** stable identity so useViewState's setView doesn't churn every render */
const NO_PARAMS: Record<string, string> = {};

/**
 * The decision cards, as a deck you swipe or a grid you scan.
 *
 * Owner, 2026-08-27, on the twelve-card grid: *"instead of having the cards take
 * up al the space in teh world and having to scroll down to see them just stack
 * them on thop of each other"*. The deck is the default because he asked for it;
 * the grid stays because it is a genuinely different reading — all twelve at
 * once, and the one that prints.
 *
 * ⚠️ The cards themselves are SERVER-rendered and arrive as nodes. Nothing about
 * a card crosses the client boundary except its layout: every figure on them is
 * still computed by the same services, on the server, exactly as before.
 */
export function DecisionCards({
  cards,
  state,
}: {
  cards: readonly DeckCard[];
  state: ViewState;
}) {
  // 🔴 It persisted and navigated on its own, beside the hero's switcher on the same page: a
  // press made while a hero press was in flight never saw it. Through the hook it builds on the
  // page's newest asked URL like every switcher on it (and keeps its clean `/?cards=` link
  // when nothing is in flight).
  const { setView } = useViewState({
    surface: DASHBOARD_SURFACE,
    spec: DECISIONS_VIEW_SPEC,
    state,
    basePath: "/",
    baseParams: NO_PARAMS,
  });
  const select = useCallback((value: string) => setView(CARDS_DIMENSION.key, value), [setView]);

  const mode = state.cards === "grid" ? "grid" : "deck";
  // 🔴 "1 readings": the runway card is built unconditionally and every other
  // card only when its service has something to say, so a young ledger's deck
  // can hold one
  const count = `${cards.length} ${cards.length === 1 ? "reading" : "readings"}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-faint">
          {mode === "deck"
            ? `${count} — swipe, scroll or use ← →`
            : count}
        </p>
        <ViewSwitcher
          dimension={CARDS_DIMENSION}
          value={mode}
          onSelect={select}
          labels={DECISIONS_VIEW_LABELS}
          ariaLabel="How the cards are laid out"
        />
      </div>

      {mode === "deck" ? (
        <CardDeck cards={cards} ariaLabel="What this means" />
      ) : (
        <div className={`grid items-start gap-4 *:min-w-0 ${cards.length > 1 ? "lg:grid-cols-2" : ""}`}>
          {cards.map((c) => (
            <div key={c.id} className="*:min-w-0">
              {c.node}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
