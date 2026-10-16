'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');
const { WhirlpoolEvents, StompDecoder, frame } = require('../lib/events');
const { logger } = require('./helpers');

test('STOMP decoder handles split frames, heartbeats, multiple messages, and multiline JSON', () => {
  const decoder = new StompDecoder();
  assert.deepEqual(decoder.feed('\nCONNECTED\nversion:1.2\n'), []);
  const frames = decoder.feed('\n\0\nMESSAGE\ndestination:/topic/ONE\n\n{\n"said":"ONE"\n}\0\n');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].command, 'CONNECTED');
  assert.deepEqual(JSON.parse(frames[1].body), { said: 'ONE' });
  assert.deepEqual(decoder.feed('\n'), []);
  assert.equal(decoder.buffer, '');
});

test('STOMP headers escape special characters', () => {
  const encoded = frame('SUBSCRIBE', { id: 'abc:123', destination: '/topic/ONE\nTWO' });
  assert(encoded.includes('id:abc\\c123'));
  assert(encoded.includes('destination:/topic/ONE\\nTWO'));
  assert(encoded.endsWith('\n\n\0'));
});

test('real WebSocket connection authenticates, subscribes, and delivers appliance attributes', async (t) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const received = [];
  const log = logger();
  const client = {
    config: { requestTimeout: 5 }, tokens: { access_token: 'PRIVATE-TEST-TOKEN' },
    ensureToken: async () => {}, websocketUrl: async () => `ws://127.0.0.1:${server.address().port}`,
  };
  const events = new WhirlpoolEvents(client, log);
  t.after(async () => {
    events.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  server.on('connection', (socket) => {
    const decoder = new StompDecoder();
    socket.on('message', (data) => {
      for (const msg of decoder.feed(data)) {
        received.push(msg.command);
        if (msg.command === 'CONNECT') {
          assert(data.toString().includes('wcloudtoken:PRIVATE-TEST-TOKEN'));
          socket.send('CONNECTED\nversion:1.2\n\n\0');
        } else if (msg.command === 'SUBSCRIBE') {
          assert(data.toString().includes('destination:/topic/ONE'));
          socket.send('MESSAGE\ndestination:/topic/ONE\n\n{"said":"ONE","attributeMap":{"Online":"1"},"timestamp":1000}\0');
        }
      }
    });
  });
  const update = once(events, 'attributes', { signal: AbortSignal.timeout(5000) });
  events.start(['ONE']);
  const [said, attrs, timestamp] = await update;
  assert.equal(said, 'ONE');
  assert.deepEqual(attrs, { Online: '1' });
  assert.equal(timestamp, 1000);
  assert.deepEqual(received, ['CONNECT', 'SUBSCRIBE']);
  assert(!JSON.stringify(log.messages).includes('PRIVATE-TEST-TOKEN'));
});

test('subscriptions are updated without reconnecting the socket', () => {
  const sent = [];
  class Socket extends EventEmitter { static OPEN = 1; }
  const events = new WhirlpoolEvents({}, logger(), { WebSocket: Socket });
  events.socket = { readyState: 1, send: (text) => sent.push(text) };
  events.connected = true;
  events.setDevices(['ONE']);
  events.setDevices(['TWO']);
  assert.equal(sent.length, 3);
  assert(sent[0].startsWith('SUBSCRIBE'));
  assert(sent[1].startsWith('UNSUBSCRIBE'));
  assert(sent[2].includes('/topic/TWO'));
  events.socket = null;
  events.stop();
});

test('invalid-token ERROR headers trigger token renewal without logging the frame', async (t) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  let renewed;
  const renewal = new Promise((resolve) => { renewed = resolve; });
  const log = logger();
  const client = {
    config: { requestTimeout: 5 }, tokens: { access_token: 'PRIVATE-TEST-TOKEN' },
    ensureToken: async (force, token) => { if (force) renewed(token); },
    websocketUrl: async () => `ws://127.0.0.1:${server.address().port}`,
  };
  const events = new WhirlpoolEvents(client, log);
  t.after(async () => {
    events.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  server.on('connection', (socket) => socket.on('message', () => {
    socket.send('ERROR\nmessage:Token Invalid\n\n\0');
  }));
  events.start(['ONE']);
  assert.equal(await renewal, 'PRIVATE-TEST-TOKEN');
  assert(!JSON.stringify(log.messages).includes('PRIVATE-TEST-TOKEN'));
});
