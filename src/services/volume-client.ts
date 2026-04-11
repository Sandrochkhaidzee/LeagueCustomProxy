// src/services/volume-client.ts
import { Position } from '../core/types';
import { SERVER_URL } from '../core/config';

interface VolumeResponse {
  myBlob: string;
  peerVolumes: Record<string, number>;
}

export class VolumeClient {
  private endpoint: string;

  constructor() {
    this.endpoint = `${SERVER_URL}/compute-volumes`;
  }

  async computeVolumes(
    myPosition: Position,
    peerBlobs: Record<string, string>,
  ): Promise<VolumeResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
      const resp = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          myPosition: { x: myPosition.x, y: myPosition.y },
          peers: peerBlobs,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`Volume API error: ${resp.status}`);
      }

      return resp.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
