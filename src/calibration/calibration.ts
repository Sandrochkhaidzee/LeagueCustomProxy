const btnConfirm = document.getElementById('btn-confirm')!;
const btnClose = document.getElementById('btn-close')!;

// In Tauri, window dragging and resizing is handled by the window config
// and data-tauri-drag-region attributes. No manual drag/resize logic needed.

// --- Confirm: send window bounds to background as minimap region ---
btnConfirm.addEventListener('click', () => {
  // In Tauri, we can get window position from the Tauri API if needed
  // For now, use the element's bounding rect as a proxy
  const bounds = {
    screenX: window.screenX,
    screenY: window.screenY,
    screenWidth: window.innerWidth,
    screenHeight: window.innerHeight,
  };

  console.log('[Calibration] Confirmed bounds:', JSON.stringify(bounds));

  // Save to localStorage for persistence
  localStorage.setItem('proxchat_minimap_bounds', JSON.stringify(bounds));

  // Send to background via window event
  window.dispatchEvent(new CustomEvent('overlayAction', {
    detail: { action: 'calibrationBounds', payload: bounds },
  }));

  btnConfirm.textContent = 'SAVED';
  btnConfirm.classList.add('saved');
  setTimeout(() => {
    btnConfirm.textContent = 'OK';
    btnConfirm.classList.remove('saved');
  }, 1500);
});

// --- Close ---
btnClose.addEventListener('click', () => {
  // TODO: Close calibration window via Tauri window API
  console.log('[Calibration] Close requested');
});

console.log('ProxChat calibration window loaded');

export {};
