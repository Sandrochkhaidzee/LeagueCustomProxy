import { invoke } from '@tauri-apps/api/core';
import { GameStateService, GameSession, TauriGameState } from './game-state';
import { SignalingService, SignalMessage, PositionBroadcast } from './signaling';
import { AudioService } from './audio';
import { TrackingService, TrackingState } from './tracking';
import { ChampionClassifier } from './champion-classifier';
import { DataChannelService } from './data-channel';
import { VolumeClient } from './volume-client';
import { PeerState } from '../core/types';
import { isStreamerMode } from '../core/streamer-detect';

export class Orchestrator {
  private gameState: GameStateService;
  private signaling: SignalingService;
  private audio: AudioService | null = null;
  private tracking: TrackingService | null = null;
  private dataChannels: DataChannelService | null = null;
  private volumeClient: VolumeClient | null = null;
  private session: GameSession | null = null;

  private localSummonerName = '';
  private peerStates: Map<string, PeerState> = new Map();
  // VAD is now handled internally by AudioService (RNNoise polling)
  private volumeTickId: number | null = null;
  private configPollId: number | null = null;
  private gameStatePollId: number | null = null;
  private positionTickRunning = false;
  private sessionActive = false;
  private lastOverlayRepositionTime = 0;
  private lastOverlayPositionKey = '';
  private leagueConfigPath: string | null = null;
  private lastMinimapScale: number | null = null;
  private dpiScale = 1;
  private overlayPositioned = false;


  constructor() {
    this.gameState = new GameStateService();
    this.signaling = new SignalingService();
  }

  start(): void {
    console.log('[ProxChat] Orchestrator.start() called');

    // Poll Tauri backend for game state every 3 seconds
    this.gameStatePollId = window.setInterval(() => this.pollGameState(), 3000) as unknown as number;

    // Also poll immediately on start
    this.pollGameState();
  }

  private async pollGameState(): Promise<void> {
    try {
      const state: TauriGameState = await this.gameState.pollGameState();

      if (!state.isLeagueRunning) {
        if (this.session) {
          console.log('[ProxChat] LoL closed, ending session');
          this.endSession();
        }
        return;
      }

      if (state.isInGame && !this.session) {
        // Game is in progress but we don't have a session yet — try to get live client data
        await this.pollForLiveClientData();
      }

      // Update death state from Tauri backend
      if (this.session && state.isDead !== this.session.localPlayer.isDead) {
        if (state.isDead) {
          this.session.localPlayer.isDead = true;
          this.tracking?.onDeath();
        } else {
          this.session.localPlayer.isDead = false;
          this.tracking?.onRespawn();
        }
      }

      if (!state.isInGame && this.session) {
        console.log('[ProxChat] Game ended (phase: ' + state.gameFlowPhase + ')');
        this.endSession();
      }
    } catch (e) {
      console.error('[ProxChat] pollGameState failed:', e);
    }
  }

  private async pollForLiveClientData(): Promise<void> {
    if (this.session) return;

    try {
      // Fetch live client data directly from League's local API via Tauri
      const lcd = await this.gameState.pollLiveClientData();
      if (lcd) {
        this.processLiveClientData(lcd);
      }
    } catch (e) {
      console.error('[ProxChat] pollForLiveClientData failed:', e);
    }
  }

  private processLiveClientData(lcd: any): void {
    if (this.session) return;

    try {
      if (lcd.activePlayer && !this.localSummonerName) {
        const active = typeof lcd.activePlayer === 'string'
          ? JSON.parse(lcd.activePlayer)
          : lcd.activePlayer;
        this.localSummonerName = active.riotId || active.summonerName || '';
        console.log('[ProxChat] Local summoner:', this.localSummonerName);
      }

      if (lcd.allPlayers && this.localSummonerName) {
        const playersData = typeof lcd.allPlayers === 'string'
          ? JSON.parse(lcd.allPlayers)
          : lcd.allPlayers;
        const players = this.gameState.parsePlayerList({ players: playersData });
        console.log('[ProxChat] Parsed players:', players.length);

        const gameMode = lcd.gameData
          ? (typeof lcd.gameData === 'string' ? JSON.parse(lcd.gameData) : lcd.gameData).gameMode || 'CLASSIC'
          : 'CLASSIC';

        const session = this.gameState.createSession(
          players,
          this.localSummonerName,
          gameMode,
        );

        if (session) {
          this.session = session;
          console.log('[ProxChat] Session created! Room:', session.roomId);
          this.startSession(session);
        }
      }
    } catch (e) {
      console.error('[ProxChat] Failed to process live client data:', e);
    }
  }

  private async startSession(session: GameSession): Promise<void> {
    console.log('[ProxChat] Starting session: room=' + session.roomId);

    // Initialize audio (mic + WebRTC)
    this.audio = new AudioService(this.signaling, this.localSummonerName);
    try {
      await this.audio.initMicrophone();
      console.log('[ProxChat] Microphone initialized');
    } catch (e) {
      console.error('[ProxChat] Mic init failed — aborting session:', e);
      this.audio = null;
      return;
    }

    // Join signaling room
    this.signaling.joinRoom(
      session.roomId,
      this.localSummonerName,
      (peer) => this.handlePeerPosition(peer),
      (signal) => this.handleSignal(signal),
      (name) => this.handlePeerLeave(name),
    );

    this.sessionActive = true;

    // Start tracking service
    try {
      // Get actual screen resolution from Tauri backend (Win32 GetSystemMetrics)
      let gameW = window.screen.width;
      let gameH = window.screen.height;
      try {
        const [w, h] = await invoke<[number, number]>('get_screen_size');
        gameW = w;
        gameH = h;
      } catch (e) {
        console.warn('[ProxChat] get_screen_size failed, using window.screen:', e);
      }
      this.dpiScale = window.devicePixelRatio || 1;
      console.log('[ProxChat] Resolution: game=' + gameW + 'x' + gameH +
        ' dpiScale=' + this.dpiScale);

      // Auto-detect League config path (use default since Tauri doesn't provide exe path)
      this.leagueConfigPath = 'C:/Riot Games/League of Legends/Config/game.cfg';
      console.log('[ProxChat] League config path:', this.leagueConfigPath);

      this.tracking = new TrackingService(gameW, gameH, session.mapType);
      this.tracking.loadChampionTemplate(session.localPlayer.championName);

      // Set capture bounds in Tauri backend
      await this.tracking.initCaptureBounds();

      // Load champion classifier (async, non-blocking — tracking works without it)
      const classifier = new ChampionClassifier();
      classifier.load(
        '../models/champion_classifier.onnx',
        '../models/champion_labels.json',
        session.localPlayer.championName,
      ).then(() => {
        if (this.tracking) {
          this.tracking.setClassifier(classifier);
          console.log('[ProxChat] Champion classifier loaded');
        }
      }).catch(err => {
        console.warn('[ProxChat] Champion classifier failed to load (tracking continues without it):', err);
      });

      // Read minimap scale from League config and apply before starting tracking
      this.readMinimapScale((scale) => {
        if (scale !== null && this.tracking) {
          this.lastMinimapScale = scale;
          this.tracking.setMinimapScaleFromConfig(scale);
        }
      });

      this.tracking.start((_pos) => {
        // Position callback — no longer directly updates audio
        // Position updates handled by volume tick
      }, 15);

      // Initialize data channel service and volume client
      this.dataChannels = new DataChannelService();
      this.volumeClient = new VolumeClient();

      // Start volume computation tick (~4Hz)
      this.volumeTickId = window.setInterval(() => this.positionTick(), 250) as unknown as number;

      // Poll game.cfg every 5 seconds for minimap scale changes
      this.configPollId = window.setInterval(() => this.pollMinimapScale(), 5000) as unknown as number;

    } catch (e) {
      console.error('[ProxChat] Tracking initialization failed:', e);
    }

    // Overlay is managed by Tauri window configuration — no manual window open needed

    // VAD is handled internally by AudioService (RNNoise polling)
  }

  private async positionTick(): Promise<void> {
    if (this.positionTickRunning) return;
    if (!this.audio || !this.session || !this.tracking || !this.volumeClient || !this.dataChannels) return;
    this.positionTickRunning = true;
    try {
      await this.positionTickInner();
    } finally {
      this.positionTickRunning = false;
    }
  }

  private async positionTickInner(): Promise<void> {
    if (!this.audio || !this.session || !this.tracking || !this.volumeClient || !this.dataChannels) return;

    // Broadcast presence over signaling so peers can discover us
    // Position is NOT included — it's exchanged only via encrypted data channel
    this.signaling.broadcastPosition({
      summonerName: this.localSummonerName,
      championName: this.session.localPlayer.championName,
      team: this.session.localPlayer.team,
      isMuted: this.audio.isSelfMuted(),
      isDead: this.session.localPlayer.isDead ?? false,
    });

    // Feed known ally peer positions to tracking for self-identification disambiguation
    const allyPeerPositions = Array.from(this.peerStates.values())
      .filter(p => p.team === this.session!.localPlayer.team && p.position.x > 0 && p.position.y > 0)
      .map(p => p.position);
    this.tracking.setPeerGamePositions(allyPeerPositions);

    // Before CV locks on (SCANNING), pass through all ally audio at full volume (fountain)
    if (this.tracking.getState() === TrackingState.SCANNING) {
      const allyVolumes: Record<string, number> = {};
      for (const [name, state] of this.peerStates) {
        if (state.team === this.session.localPlayer.team) {
          allyVolumes[name] = 1.0;
        }
      }
      this.audio.applyPeerVolumes(allyVolumes);
      this.broadcastOverlayState();
      return;
    }

    const position = this.tracking.getLastPosition();
    if (!position || (position.x === 0 && position.y === 0)) {
      this.broadcastOverlayState();
      return;
    }

    try {
      // Collect encrypted blobs received from peers
      const peerBlobs = this.dataChannels.getPeerBlobs();

      // Call Edge Function: encrypt our position + compute volumes
      const result = await this.volumeClient.computeVolumes(position, peerBlobs);

      // Silent — peer connect/disconnect logged elsewhere

      // Broadcast our encrypted blob to all peers
      this.dataChannels.broadcastBlob(result.myBlob);

      // Apply volume levels to audio streams
      this.audio.applyPeerVolumes(result.peerVolumes);
    } catch (e) {
      console.error('[ProxChat] Volume computation failed:', e);
    }

    this.broadcastOverlayState();
  }

  private async handlePeerPosition(peer: PositionBroadcast): Promise<void> {
    if (!this.session || !this.audio) return;

    // Skip streamer mode players
    const player = this.session.allPlayers.find(
      (p) => p.summonerName === peer.summonerName,
    );
    if (player && isStreamerMode(player)) return;

    const existing = this.peerStates.get(peer.summonerName);
    const peerState: PeerState = {
      summonerName: peer.summonerName,
      championName: peer.championName,
      team: peer.team as 'ORDER' | 'CHAOS',
      position: existing?.position ?? { x: 0, y: 0 },
      isMuted: peer.isMuted,
      isDead: peer.isDead,
    };

    this.peerStates.set(peer.summonerName, peerState);

    // Connect to peer (audio + data channel)
    try {
      if (!this.audio.hasPeer(peer.summonerName)) {
        const isInitiator = this.localSummonerName < peer.summonerName;
        await this.audio.connectToPeer(peer.summonerName, isInitiator);
      }
      // Always register with DataChannelService (peer may have been created by handleSignal)
      const peerConn = this.audio.getPeer(peer.summonerName);
      if (peerConn && this.dataChannels && !this.dataChannels.hasPeer(peer.summonerName)) {
        this.dataChannels.registerPeer(peer.summonerName, peerConn);
      }
    } catch (e) {
      console.error('[ProxChat] Failed to connect to peer:', peer.summonerName, e);
      this.peerStates.delete(peer.summonerName);
    }
  }

  private async handleSignal(signal: SignalMessage): Promise<void> {
    await this.audio?.handleSignal(signal);
  }

  private handlePeerLeave(name: string): void {
    this.audio?.disconnectPeer(name);
    this.dataChannels?.unregisterPeer(name);
    this.peerStates.delete(name);
    this.broadcastOverlayState();
  }

  private broadcastOverlayState(): void {
    const audio = this.audio;
    if (!audio) return;

    const nearbyPeers = Array.from(this.peerStates.values())
      .map((p) => ({
        summonerName: p.summonerName,
        championName: p.championName,
        team: p.team,
        isMuted: p.isMuted,
        isMutedByLocal: audio.isPlayerMuted(p.summonerName),
        isDead: p.isDead,
      }));

    const data = {
      selfMuted: audio.isSelfMuted(),
      muteAll: audio.isMuteAll(),
      nearbyPeers,
      trackingState: this.tracking?.getState() ?? 'none',
      lastPosition: this.tracking?.getLastPosition() ?? null,
      filteredImageUrl: this.tracking?.getFilteredImageUrl() ?? null,
      detectedMinimapBounds: this.tracking?.getDetectedMinimapScreenBounds() ?? null,
    };

    // Auto-position overlay above the minimap when bounds are detected
    if (data.detectedMinimapBounds && !this.overlayPositioned) {
      const mb = data.detectedMinimapBounds;
      invoke('position_overlay', {
        x: mb.screenX,
        y: mb.screenY,
        width: mb.screenWidth,
        height: mb.screenHeight,
      }).then(() => {
        console.log('[ProxChat] Overlay positioned above minimap');
        this.overlayPositioned = true;
      }).catch((e) => console.warn('[ProxChat] position_overlay failed:', e));
    }

    // Broadcast to overlay via custom event (both windows share the same WebView in Tauri)
    window.dispatchEvent(new CustomEvent('overlayUpdate', { detail: data }));
  }

  // Public controls (called from overlay via messaging)
  toggleSelfMute(): boolean { return this.audio?.toggleSelfMute() ?? false; }
  toggleMuteAll(): boolean { return this.audio?.toggleMuteAll() ?? false; }
  toggleMutePlayer(name: string): boolean { return this.audio?.toggleMutePlayer(name) ?? false; }
  setPlayerVolume(name: string, volume: number): void { this.audio?.setPlayerVolume(name, volume); }
  setScanRate(fps: number): void {
    if (!this.tracking) return;
    const clamped = Math.max(1, Math.min(30, Math.round(fps)));
    console.log('[ProxChat] Scan rate changed to ' + clamped + ' FPS');
    this.tracking.stop();
    this.tracking.start(() => {
      // Position updates handled by volume tick
    }, clamped);
  }
  setPTTState(held: boolean): void { this.audio?.setPTTState(held); }
  updateSettings(settings: any): void { this.audio?.updateSettings(settings); }

  getSessionPlayers(): { summonerName: string; championName: string; team: string }[] {
    if (!this.session) return [];
    return this.session.allPlayers.map((p) => ({
      summonerName: p.summonerName,
      championName: p.championName,
      team: p.team,
    }));
  }

  private calibrationIndex = 0;

  captureCalibrationData(data: any): void {
    this.calibrationIndex++;
    const idx = String(this.calibrationIndex).padStart(3, '0');

    // TODO: Implement calibration data saving via Tauri file system commands
    console.log('[ProxChat] Calibration capture #' + idx, JSON.stringify(data).substring(0, 200));

    // Capture minimap screenshot via Tauri
    invoke<{ data_url: string; width: number; height: number }>('capture_minimap')
      .then((result) => {
        console.log('[ProxChat] Calibration minimap captured:', idx, 'size:', result.data_url.length);
      })
      .catch((err) => {
        console.error('[ProxChat] Calibration capture failed:', err);
      });
  }

  /**
   * Receive minimap screen bounds from calibration overlay and convert to
   * capture-relative coordinates for the tracking service.
   */
  setMinimapCalibration(bounds: { screenX: number; screenY: number; screenWidth: number; screenHeight: number }): void {
    if (!this.tracking) {
      console.warn('[ProxChat] setMinimapCalibration called but no tracking service');
      return;
    }
    const capture = this.tracking.captureBounds;
    // Convert screen coordinates to capture-relative coordinates
    const region = {
      x: bounds.screenX - capture.x,
      y: bounds.screenY - capture.y,
      width: bounds.screenWidth,
      height: bounds.screenHeight,
    };
    console.log('[ProxChat] Calibration bounds (screen):', JSON.stringify(bounds));
    console.log('[ProxChat] Calibration region (capture-relative):', JSON.stringify(region));
    this.tracking.setMinimapRegion(region);
  }

  /**
   * Derive the League config directory.
   * TODO: Get actual install path from Tauri backend (e.g., from LCU lockfile location).
   * Falls back to the default install path.
   */
  private resolveLeagueConfigPath(): string {
    return 'C:/Riot Games/League of Legends/Config/game.cfg';
  }

  /**
   * Read MinimapScale from League's game.cfg. The file is an INI-style config
   * with [Section] headers. MinimapScale is under [HUD] and ranges from 0.0 to 1.0.
   */
  private readMinimapScale(callback: (scale: number | null) => void): void {
    if (!this.leagueConfigPath) {
      console.warn('[ProxChat] readMinimapScale: no config path');
      callback(null);
      return;
    }

    // Read game.cfg via Tauri backend
    invoke<string>('read_text_file', { path: this.leagueConfigPath })
      .then(text => this.parseMinimapScale(text, callback))
      .catch(err => {
        console.warn('[ProxChat] Failed to read game.cfg:', err);
        callback(null);
      });
  }

  private parseMinimapScale(text: string, callback: (scale: number | null) => void): void {
    const lines = text.split('\n');
    let inHudSection = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        inHudSection = trimmed.toLowerCase() === '[hud]';
        continue;
      }
      if (inHudSection && trimmed.toLowerCase().startsWith('minimapscale=')) {
        const rawVal = trimmed.split('=')[1].trim();
        const val = parseFloat(rawVal);
        if (!isNaN(val)) {
          console.log('[ProxChat] MinimapScale raw="' + rawVal + '" parsed=' + val);
          callback(val);
          return;
        }
      }
    }
    console.warn('[ProxChat] MinimapScale not found in game.cfg, text length=' + text.length);
    callback(null);
  }

  /**
   * Poll game.cfg for MinimapScale changes and update tracking bounds.
   */
  private pollMinimapScale(): void {
    this.readMinimapScale((scale) => {
      if (scale === null || !this.tracking) return;
      if (scale !== this.lastMinimapScale) {
        console.log('[ProxChat] MinimapScale changed:', this.lastMinimapScale, '->', scale);
        this.lastMinimapScale = scale;
        this.tracking.setMinimapScaleFromConfig(scale);
      }
    });
  }

  private endSession(): void {
    this.positionTickRunning = false;
    this.sessionActive = false;

    if (this.volumeTickId !== null) {
      clearInterval(this.volumeTickId);
      this.volumeTickId = null;
    }
    if (this.configPollId !== null) {
      clearInterval(this.configPollId);
      this.configPollId = null;
    }

    this.tracking?.stop();
    this.tracking = null;
    this.dataChannels = null;
    this.volumeClient = null;
    this.audio?.cleanup();
    this.signaling.leaveRoom();
    this.gameState.clearSession();
    this.session = null;
    this.peerStates.clear();
    this.localSummonerName = '';

    // Notify overlay that session ended
    window.dispatchEvent(new CustomEvent('sessionEnded'));
  }
}
