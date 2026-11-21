"use client";
// <Playground model="..." /> renders a registered playground. Usable in MDX anywhere.
import type { ComponentType } from "react";
import type { PlaygroundName } from "./names";
import StrategyCheckout from "./strategy-checkout/View";

const REGISTRY: Record<PlaygroundName, ComponentType> = {
  "strategy-checkout": StrategyCheckout,
};

export function Playground({ model }: { model: string }) {
  const View = REGISTRY[model as PlaygroundName];
  if (!View) return <p className="pg-empty">Unknown playground “{model}”.</p>;
  return <View />;
}
