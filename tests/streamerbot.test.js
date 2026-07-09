import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EVENTS } from '../src/integrations/streamerbot.js';

test('DEFAULT_EVENTS relaie les pulses Pulsoid via Streamer.bot', () => {
  assert.ok(DEFAULT_EVENTS.includes('Pulsoid.HeartRatePulse'));
});

test('DEFAULT_EVENTS ne relaie plus les events Twitch depuis Streamer.bot', () => {
  assert.equal(DEFAULT_EVENTS.includes('General.Custom'), false);
  assert.equal(DEFAULT_EVENTS.includes('Twitch.Announcement'), false);
});
