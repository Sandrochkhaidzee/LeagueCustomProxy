import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTransmitIndicatorLive } from './audio-transmit.ts';

describe('isTransmitIndicatorLive', () => {
  it('IDLE when vad mode and not speaking', () => {
    assert.equal(isTransmitIndicatorLive('vad', false, false, false), false);
  });

  it('LIVE when vad mode and speaking', () => {
    assert.equal(isTransmitIndicatorLive('vad', false, true, false), true);
  });

  it('MUTED overrides speech', () => {
    assert.equal(isTransmitIndicatorLive('vad', true, true, false), false);
  });

  it('PTT follows key held', () => {
    assert.equal(isTransmitIndicatorLive('ptt', false, false, true), true);
    assert.equal(isTransmitIndicatorLive('ptt', false, true, false), false);
  });
});
