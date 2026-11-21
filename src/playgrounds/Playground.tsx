"use client";
// <Playground model="..." /> renders the playground in src/playgrounds/<model>/View.tsx.
// Usable in MDX anywhere. The registry is generated from the folders (scripts/gen-registry.mjs).
//
// Playgrounds render in the browser only. They are interactive simulations, excluded from
// search, and some compute values with Math.log/exp/cos, whose last bit can differ between the
// Node that builds the page and the reader's browser; rendering them on the server could then
// produce a hydration mismatch.
import { useEffect, useState } from "react";
import { REGISTRY } from "./registry.generated";

export function Playground({ model }: { model: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const View = REGISTRY[model];
  if (!View) return <p className="pg-empty">Unknown playground “{model}”.</p>;
  if (!mounted) return <div className="pg pg-loading" aria-busy="true"><p className="pg-empty">Loading the playground…</p></div>;
  return <View />;
}
