"use client";
// <Playground model="..." /> renders the playground in src/playgrounds/<model>/View.tsx.
// Usable in MDX anywhere. The registry is generated from the folders (scripts/gen-registry.mjs).
import { REGISTRY } from "./registry.generated";

export function Playground({ model }: { model: string }) {
  const View = REGISTRY[model];
  if (!View) return <p className="pg-empty">Unknown playground “{model}”.</p>;
  return <View />;
}
