// Console log toggling — silenced by default, re-enabled when the user
// turns on Debug in the overlay. console.error is never silenced; real
// failures should always surface in dev tools.

const noop = (): void => { /* swallowed */ };
const originals = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
  debug: (console as any).debug ? console.debug.bind(console) : console.log.bind(console),
};

// Initial state mirrors what console actually does (un-patched).
// We immediately silence at module-load below so anything imported
// after this module sees a silent console.
let enabled = true;

export function setLoggingEnabled(value: boolean): void {
  if (value === enabled) return;
  enabled = value;
  if (value) {
    console.log = originals.log;
    console.warn = originals.warn;
    console.info = originals.info;
    (console as any).debug = originals.debug;
  } else {
    console.log = noop;
    console.warn = noop;
    console.info = noop;
    (console as any).debug = noop;
  }
}

export function isLoggingEnabled(): boolean {
  return enabled;
}

// Silence at module load — anything that imports this gets a quiet console.
setLoggingEnabled(false);
