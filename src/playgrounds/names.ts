// Every playground model a topic may name in `playground.model` or `<Playground model="..." />`.
// Kept free of React so the content loader can validate names at build time.
export const PLAYGROUND_NAMES = ["strategy-checkout"] as const;
export type PlaygroundName = (typeof PLAYGROUND_NAMES)[number];
