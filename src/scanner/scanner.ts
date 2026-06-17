import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { listen } from '@tauri-apps/api/event';

const scannerRoot = document.getElementById('scanner-root')!;

interface SceneUpdate {
  debugEnabled: boolean;
}

listen<SceneUpdate>('scanner:scene', (event) => {
  const { debugEnabled } = event.payload;
  scannerRoot.style.boxShadow = debugEnabled
    ? 'inset 0 0 0 3px rgba(255, 0, 0, 0.85)'
    : '';
}).catch((e) => console.warn('[Scanner] scanner:scene listen failed:', e));

let calibrationActive = false;

function setCalibrationActive(active: boolean): void {
  calibrationActive = active;
  document.body.classList.toggle('calibration-active', active);
}

listen('calibration:begin', () => setCalibrationActive(true)).catch(() => {});
listen('calibration:end', () => setCalibrationActive(false)).catch(() => {});

interface DragState {
  kind: string;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
}

let drag: DragState | null = null;

async function readBounds(): Promise<{ x: number; y: number; w: number; h: number }> {
  const b = await invoke<{
    screen_x: number;
    screen_y: number;
    screen_width: number;
    screen_height: number;
  }>('get_scanner_screen_bounds');
  return { x: b.screen_x, y: b.screen_y, w: b.screen_width, h: b.screen_height };
}

async function emitBounds(): Promise<void> {
  const b = await invoke<{
    screen_x: number;
    screen_y: number;
    screen_width: number;
    screen_height: number;
  }>('get_scanner_screen_bounds');
  await emit('calibration:bounds', b);
}

function onPointerDown(e: PointerEvent, kind: string): void {
  if (!calibrationActive) return;
  e.preventDefault();
  e.stopPropagation();
  void readBounds().then((b) => {
    drag = {
      kind,
      startX: e.screenX,
      startY: e.screenY,
      origX: b.x,
      origY: b.y,
      origW: b.w,
      origH: b.h,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  });
}

function onPointerMove(e: PointerEvent): void {
  if (!drag || !calibrationActive) return;
  e.preventDefault();
  const dx = e.screenX - drag.startX;
  const dy = e.screenY - drag.startY;
  let { origX: x, origY: y, origW: w, origH: h } = drag;
  switch (drag.kind) {
    case 'corner-tr':
      w = drag.origW + dx;
      h = drag.origH - dy;
      y = drag.origY + dy;
      break;
    case 'corner-br':
      w = drag.origW + dx;
      h = drag.origH + dy;
      break;
    case 'edge-top':
      h = drag.origH - dy;
      y = drag.origY + dy;
      break;
    case 'edge-right':
      w = drag.origW + dx;
      break;
    case 'edge-bottom':
      h = drag.origH + dy;
      break;
    default:
      break;
  }
  w = Math.max(40, w);
  h = Math.max(40, h);
  void invoke('set_scanner_bounds', { x, y, width: w, height: h });
}

function onPointerUp(e: PointerEvent): void {
  if (!drag) return;
  drag = null;
  void emitBounds();
  try {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  } catch { /* ignore */ }
}

const handles: [string, string][] = [
  ['corner-tr', '#corner-tr'],
  ['corner-br', '#corner-br'],
  ['edge-top', '#edge-top'],
  ['edge-right', '#edge-right'],
  ['edge-bottom', '#edge-bottom'],
];

for (const [kind, sel] of handles) {
  const el = document.querySelector(sel) as HTMLElement | null;
  if (!el) continue;
  el.addEventListener('pointerdown', (e) => onPointerDown(e, kind));
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);
}


export {};
