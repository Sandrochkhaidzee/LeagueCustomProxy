// Typed declarations for app-specific properties we hang off the global
// `window` object as an ad-hoc cross-module bus. Import this module (for its
// side effect of augmenting the `Window` interface) from anywhere those
// properties are read or written.

declare global {
  interface Window {
    /**
     * Set by overlay.ts whenever the Debug toggle flips; read by orchestrator.ts
     * before emitting `scanner:scene` so the scanner only renders debug visuals
     * while Debug is on.
     */
    __lolproxchat_debug_enabled?: boolean;
  }
}

export {};
