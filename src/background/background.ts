import { invoke } from '@tauri-apps/api/core';
import { Orchestrator } from '../services/orchestrator';

console.log('[ProxChat] Background script loading...');

const orchestrator = new Orchestrator();
orchestrator.start();

console.log('[ProxChat] Orchestrator started');

// Listen for messages from overlay (Tauri uses window events instead of Overwolf messaging)
window.addEventListener('overlayAction', ((event: CustomEvent) => {
  const { action, payload } = event.detail;
  console.log('[ProxChat] Received action from overlay:', action);
  switch (action) {
    case 'toggleSelfMute':
      orchestrator.toggleSelfMute();
      break;
    case 'toggleMuteAll':
      orchestrator.toggleMuteAll();
      break;
    case 'toggleMutePlayer':
      orchestrator.toggleMutePlayer(payload.name);
      break;
    case 'setPlayerVolume':
      orchestrator.setPlayerVolume(payload.name, payload.volume);
      break;
    case 'setScanRate':
      orchestrator.setScanRate(payload.fps);
      break;
    case 'setPTT':
      orchestrator.setPTTState(payload.held);
      break;
    case 'updateSettings':
      orchestrator.updateSettings(payload);
      break;
    case 'calibrationBounds':
      orchestrator.setMinimapCalibration(payload);
      break;
    case 'panelResize':
      // Tell the Rust click-through loop how big the interactive zone is.
      invoke('set_panel_size', { width: payload.width, height: payload.height })
        .catch(() => { /* ignore — loop falls back to last value */ });
      break;
  }
}) as EventListener);

// TODO: Add global shortcuts via @tauri-apps/plugin-global-shortcut for PTT and toggle mute

console.log('LoLProxChat background service started');
