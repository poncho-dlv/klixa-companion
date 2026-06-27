import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EVENTS } from '../src/integrations/streamerbot.js';

test('DEFAULT_EVENTS relaie les pulses Pulsoid via Streamer.bot', () => {
  assert.ok(DEFAULT_EVENTS.includes('Pulsoid.HeartRatePulse'));
});

test('DEFAULT_EVENTS garde les events Streamer.bot legacy attendus', () => {
  assert.ok(DEFAULT_EVENTS.includes('General.Custom'));
  assert.ok(DEFAULT_EVENTS.includes('Twitch.Announcement'));
});
