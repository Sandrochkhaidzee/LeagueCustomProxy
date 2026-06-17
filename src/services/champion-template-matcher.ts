import { cropToGrayscale32, normalizedCrossCorrelation } from './template-match-math';

// Community Dragon icon path:
// https://raw.communitydragon.org/latest/game/assets/characters/{folder}/hud/{folder}_square_0.png

const CD_BASE = 'https://raw.communitydragon.org/latest/game/assets/characters';

const DISPLAY_TO_FOLDER: Record<string, string> = {
  'nunu & willump': 'nunu',
  'dr. mundo': 'drmundo',
  'miss fortune': 'missfortune',
  'twisted fate': 'twistedfate',
  'jarvan iv': 'jarvaniv',
  'aurelion sol': 'aurelionsol',
  'bel\'veth': 'belveth',
  'cho\'gath': 'chogath',
  'kai\'sa': 'kaisa',
  'kha\'zix': 'khazix',
  'kog\'maw': 'kogmaw',
  'k\'sante': 'ksante',
  'lee sin': 'leesin',
  'master yi': 'masteryi',
  'rek\'sai': 'reksai',
  'renata glasc': 'renata',
  'tahm kench': 'tahmkench',
  'xin zhao': 'xinzhao',
};

function championToCdFolder(championName: string): string {
  const lower = championName.toLowerCase().trim();
  if (DISPLAY_TO_FOLDER[lower]) return DISPLAY_TO_FOLDER[lower];
  return lower.replace(/[^a-z0-9]/g, '');
}

export class ChampionTemplateMatcher {
  private template: Float32Array | null = null;
  private championName = '';

  isLoaded(): boolean {
    return this.template !== null;
  }

  async load(championName: string): Promise<boolean> {
    this.championName = championName;
    const folder = championToCdFolder(championName);
    const url = `${CD_BASE}/${folder}/hud/${folder}_square_0.png`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(bmp, 0, 0, 32, 32);
      const img = ctx.getImageData(0, 0, 32, 32);
      this.template = cropToGrayscale32(img.data, 32, 0, 0, 32, 32);
      console.log('[TemplateMatcher] Loaded icon for', championName, 'from', url);
      return true;
    } catch (e) {
      console.warn('[TemplateMatcher] Failed to load template for', championName, ':', e);
      this.template = null;
      return false;
    }
  }

  scoreCrop(
    imageData: ImageData,
    cropX: number,
    cropY: number,
    cropW: number,
    cropH: number,
  ): number {
    if (!this.template) return 0;
    const gray = cropToGrayscale32(
      imageData.data,
      imageData.width,
      cropX,
      cropY,
      cropW,
      cropH,
    );
    return normalizedCrossCorrelation(gray, this.template);
  }

  getChampionName(): string {
    return this.championName;
  }
}
