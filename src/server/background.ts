import { invoke } from '@tauri-apps/api/core';
import '../core/window-globals';

window.addEventListener('overlayAction', ((event: CustomEvent) => {
  const { action, payload } = event.detail;
  switch (action) {
    case 'panelResize':
      invoke('set_panel_size', { width: payload.width, height: payload.height })
        .catch(() => { /* ignore */ });
      break;
    case 'resizeOverlay':
      invoke('resize_overlay', { height: payload.height })
        .catch((e) => console.warn('[Server] resize_overlay failed:', e));
      break;
    default:
      break;
  }
}) as EventListener);
