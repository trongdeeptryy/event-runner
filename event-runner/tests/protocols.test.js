/**
 * Bộ kiểm thử giao thức nhị phân (Art-Net, sACN, OSC), đồng hồ nhịp MasterBeatClock,
 * phân tích 3 dải âm thanh, tính toán DMX 512 và di trú dự án v1 -> v2 cho EVENT RUNNER v3.0 Pro.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const logic = require('../src/shared/logic');
const dmxProtocol = require('../src/shared/dmx-protocol');
const oscProtocol = require('../src/shared/osc-protocol');

test('Art-Net buildArtNetPacket: độ dài 530 byte, header Art-Net\\0, OpCode 0x5000 LE, universe, sequence & kênh DMX', () => {
  const ch = new Uint8Array(512);
  ch[0] = 255;
  ch[1] = 128;
  ch[10] = 64;
  ch[511] = 200;

  const pkt = dmxProtocol.buildArtNetPacket(258, ch, 42);
  assert.equal(pkt.length, 530);
  assert.equal(pkt.toString('ascii', 0, 8), 'Art-Net\0');
  assert.equal(pkt.readUInt16LE(8), 0x5000);
  assert.equal(pkt.readUInt16BE(10), 0x000e);
  assert.equal(pkt[12], 42);
  assert.equal(pkt[13], 0);
  assert.equal(pkt.readUInt16LE(14), 258);
  assert.equal(pkt.readUInt16BE(16), 512);
  assert.equal(pkt[18], 255);
  assert.equal(pkt[19], 128);
  assert.equal(pkt[28], 64);
  assert.equal(pkt[529], 200);

  // Kiểm tra xoay vòng sequence 1..255
  const pktWrap = dmxProtocol.buildArtNetPacket(0, ch, 256);
  assert.equal(pktWrap[12], 1);
  const pktZeroSeq = dmxProtocol.buildArtNetPacket(0, ch, 0);
  assert.equal(pktZeroSeq[12], 1);
});

test('sACN buildSacnPacket & getSacnMulticastIp: độ dài 638 byte, ASC-E1.17, universe, kênh DMX & IP multicast', () => {
  const ch = new Uint8Array(512);
  ch[0] = 180;
  ch[4] = 255;
  ch[511] = 99;

  const customCid = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const pkt = dmxProtocol.buildSacnPacket(300, ch, 77, 'ShowVN', customCid);
  assert.equal(pkt.length, 638);
  assert.equal(pkt.readUInt16BE(0), 0x0010);
  assert.equal(pkt.readUInt16BE(2), 0x0000);
  assert.equal(pkt.toString('ascii', 4, 16), 'ASC-E1.17\0\0\0');
  assert.equal(pkt.readUInt32BE(18), 0x00000004);
  assert.deepEqual(pkt.subarray(22, 38), customCid);
  assert.equal(pkt.readUInt32BE(40), 0x00000002);
  assert.equal(pkt.toString('utf8', 44, 50), 'ShowVN');
  assert.equal(pkt[108], 100);
  assert.equal(pkt[111], 77);
  assert.equal(pkt.readUInt16BE(113), 300);
  assert.equal(pkt[117], 0x02);
  assert.equal(pkt[118], 0xa1);
  assert.equal(pkt.readUInt16BE(123), 513);
  assert.equal(pkt[125], 0x00); // DMX Start Code
  assert.equal(pkt[126], 180);
  assert.equal(pkt[130], 255);
  assert.equal(pkt[637], 99);

  assert.equal(dmxProtocol.getSacnMulticastIp(1), '239.255.0.1');
  assert.equal(dmxProtocol.getSacnMulticastIp(258), '239.255.1.2');
  assert.equal(dmxProtocol.getSacnMulticastIp(63999), '239.255.249.255');
});

test('OSC buildOscPacket & parseOscPacket: round-trip int, float, string, bool, blob, N, I & căn lề 4 byte', () => {
  const blob = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01]);
  const pkt = oscProtocol.buildOscPacket('/er/test/vals', [
    42,
    -7,
    0.5,
    'Xin chào LED',
    true,
    false,
    blob,
    null,
    Infinity
  ]);
  assert.equal(pkt.length % 4, 0);

  const parsed = oscProtocol.parseOscPacket(pkt);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].address, '/er/test/vals');
  assert.equal(parsed[0].args.length, 9);
  assert.equal(parsed[0].args[0], 42);
  assert.equal(parsed[0].args[1], -7);
  assert.ok(Math.abs(parsed[0].args[2] - 0.5) < 1e-6);
  assert.equal(parsed[0].args[3], 'Xin chào LED');
  assert.equal(parsed[0].args[4], true);
  assert.equal(parsed[0].args[5], false);
  assert.ok(Buffer.isBuffer(parsed[0].args[6]));
  assert.deepEqual(parsed[0].args[6], blob);
  assert.equal(parsed[0].args[7], null);
  assert.equal(parsed[0].args[8], Infinity);
});

test('OSC parseOscPacket: giải mã #bundle lồng nhau và chống lỗi buffer hỏng / cắt cụt', () => {
  const m1 = oscProtocol.buildOscPacket('/er/go', []);
  const m2 = oscProtocol.buildOscPacket('/er/bpm', [128]);
  const m3 = oscProtocol.buildOscPacket('/er/tbar', [0.75]);
  const innerBundle = oscProtocol.buildOscBundle([m2, m3]);
  const outerBundle = oscProtocol.buildOscBundle([m1, innerBundle]);

  const messages = oscProtocol.parseOscPacket(outerBundle);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0], { address: '/er/go', args: [] });
  assert.deepEqual(messages[1], { address: '/er/bpm', args: [128] });
  assert.equal(messages[2].address, '/er/tbar');
  assert.ok(Math.abs(messages[2].args[0] - 0.75) < 1e-6);

  // Dữ liệu sai/hỏng không bao giờ được ném lỗi
  const malformedInputs = [
    null,
    undefined,
    'not-a-buffer',
    12345,
    Buffer.alloc(0),
    Buffer.from('garbage-no-null-byte'),
    Buffer.from('/er/go\0\0,i\0\0\x00\x01'), // int bị cắt cụt
    Buffer.from('/er/blob\0\0\0\0,b\0\0\xff\xff\xff\xff'), // độ dài blob âm
    Buffer.from('/er/blob\0\0\0\0,b\0\0\x00\x00\x01\x00abc'), // độ dài blob vượt kích thước buffer
    Buffer.from('#bundle\0\x00\x00\x00\x00\x00\x00\x00\x01\x7f\xff\xff\xff') // bundle element size vượt quá
  ];
  for (const bad of malformedInputs) {
    assert.doesNotThrow(() => {
      const res = oscProtocol.parseOscPacket(bad);
      assert.ok(Array.isArray(res));
    });
  }
});

test('MasterBeatClock: divider 0.5/1/2/4, beatInBar 0..3, nudge và resync', () => {
  // 120 BPM => 500 ms/beat
  const clk = new logic.MasterBeatClock(120, 1);
  const s0 = clk.step(1000);
  assert.equal(s0.isBeat, true);
  assert.equal(s0.isSubBeat, true);
  assert.equal(s0.beatIndex, 0);
  assert.equal(s0.beatInBar, 0);
  assert.ok(Math.abs(s0.phase - 0) < 1e-6);

  const sMid = clk.step(1250);
  assert.equal(sMid.isBeat, false);
  assert.ok(Math.abs(sMid.phase - 0.5) < 1e-6);

  const s1 = clk.step(1500);
  assert.equal(s1.isBeat, true);
  assert.equal(s1.beatIndex, 1);
  assert.equal(s1.beatInBar, 1);

  assert.equal(clk.step(2000).beatInBar, 2);
  assert.equal(clk.step(2500).beatInBar, 3);
  assert.equal(clk.step(3000).beatInBar, 0);

  // Kiểm tra divider = 2 (250 ms/sub-beat)
  const clk2x = new logic.MasterBeatClock(120, 2);
  clk2x.step(0);
  const sub1 = clk2x.step(250);
  assert.equal(sub1.isBeat, false);
  assert.equal(sub1.isSubBeat, true);
  assert.equal(sub1.subBeatIndex, 1);

  // Kiểm tra divider = 4 (125 ms/sub-beat)
  const clk4x = new logic.MasterBeatClock(120, 4);
  clk4x.step(0);
  assert.equal(clk4x.step(125).isSubBeat, true);
  assert.equal(clk4x.step(250).isSubBeat, true);
  assert.equal(clk4x.step(375).isSubBeat, true);

  // Kiểm tra divider = 0.5 (1000 ms/sub-beat = nửa nhịp, tức 2 beat 1 sub-beat)
  const clkHalf = new logic.MasterBeatClock(120, 0.5);
  clkHalf.step(0);
  const at500 = clkHalf.step(500);
  assert.equal(at500.isBeat, true);
  assert.equal(at500.isSubBeat, false);
  const at1000 = clkHalf.step(1000);
  assert.equal(at1000.isBeat, true);
  assert.equal(at1000.isSubBeat, true);

  // Kiểm tra nudge & resync
  const clkNudge = new logic.MasterBeatClock(120, 1);
  const before = clkNudge.step(100); // phase = 0 tại t=100 (anchor=100)
  assert.equal(before.phase, 0);
  clkNudge.nudge(125); // dời pha tiến +125ms (+0.25 beat)
  const after = clkNudge.step(100);
  assert.ok(Math.abs(after.phase - 0.25) < 1e-6);

  clkNudge.resync(5000);
  const resynced = clkNudge.step(5000);
  assert.equal(resynced.isBeat, true);
  assert.equal(resynced.beatIndex, 0);
  assert.equal(resynced.beatInBar, 0);
  assert.equal(resynced.phase, 0);
});

test('estimateBpmFromBeatTimes: < 4 mốc trả về null, tính BPM chuẩn và giới hạn [60..200]', () => {
  assert.equal(logic.estimateBpmFromBeatTimes([]), null);
  assert.equal(logic.estimateBpmFromBeatTimes([0, 500, 1000]), null);

  // 120 BPM => 500ms/beat
  const est120 = logic.estimateBpmFromBeatTimes([1000, 1500, 2000, 2500, 3000]);
  assert.ok(est120);
  assert.equal(est120.bpm, 120);
  assert.ok(est120.confidence > 0.9);

  // 40 BPM (1500ms) -> kẹp xuống 60
  const estLow = logic.estimateBpmFromBeatTimes([0, 1500, 3000, 4500]);
  assert.ok(estLow);
  assert.equal(estLow.bpm, 60);

  // 240 BPM (250ms) -> kẹp lên 200
  const estHigh = logic.estimateBpmFromBeatTimes([0, 250, 500, 750, 1000]);
  assert.ok(estHigh);
  assert.equal(estHigh.bpm, 200);
});

test('computeThreeBandEnergy: tách biệt chính xác dải Bass (20-160Hz), Mid (160-2kHz), High (2k-12kHz)', () => {
  const sampleRate = 48000;
  const fftSize = 2048;
  const binHz = sampleRate / fftSize; // ~23.4375 Hz/bin

  // Bass only (60 Hz -> bin ~2..3)
  const bassOnly = new Uint8Array(1024);
  bassOnly[Math.round(60 / binHz)] = 255;
  const eBass = logic.computeThreeBandEnergy(bassOnly, sampleRate, fftSize);
  assert.ok(eBass.bass > 0 && eBass.bass <= 1);
  assert.equal(eBass.mid, 0);
  assert.equal(eBass.high, 0);

  // Mid only (800 Hz)
  const midOnly = new Uint8Array(1024);
  midOnly[Math.round(800 / binHz)] = 255;
  const eMid = logic.computeThreeBandEnergy(midOnly, sampleRate, fftSize);
  assert.equal(eMid.bass, 0);
  assert.ok(eMid.mid > 0 && eMid.mid <= 1);
  assert.equal(eMid.high, 0);

  // High only (6000 Hz)
  const highOnly = new Uint8Array(1024);
  highOnly[Math.round(6000 / binHz)] = 255;
  const eHigh = logic.computeThreeBandEnergy(highOnly, sampleRate, fftSize);
  assert.equal(eHigh.bass, 0);
  assert.equal(eHigh.mid, 0);
  assert.ok(eHigh.high > 0 && eHigh.high <= 1);

  assert.deepEqual(logic.computeThreeBandEnergy(null), { bass: 0, mid: 0, high: 0 });
});

test('computeDmxFrame: xuất đúng kênh cho tất cả 6 loại fixture, 6 chế độ DMX, blackout & masterDimmer', () => {
  const fixtures = [
    { id: 'f1', name: 'RGB', type: 'rgb', startChannel: 1, group: 'A' },        // ch 1..3 (idx 0..2)
    { id: 'f2', name: 'RGBW', type: 'rgbw', startChannel: 10, group: 'A' },     // ch 10..13 (idx 9..12)
    { id: 'f3', name: 'DRGB', type: 'drgb', startChannel: 20, group: 'A' },     // ch 20..23 (idx 19..22)
    { id: 'f4', name: 'DRGBS', type: 'drgbs', startChannel: 30, group: 'B' },   // ch 30..34 (idx 29..33)
    { id: 'f5', name: 'DRGBWS', type: 'drgbws', startChannel: 40, group: 'B' }, // ch 40..45 (idx 39..44)
    { id: 'f6', name: 'Strobe', type: 'strobe', startChannel: 50, group: 'B' }  // ch 50..51 (idx 49..50)
  ];

  const baseCfg = logic.createDefaultDmxConfig({
    enabled: true,
    masterDimmer: 100,
    blackout: false,
    fixtures
  });

  const whiteSolidSync = logic.createDefaultLedSync({
    on: true,
    palette: 'white',
    intensity: 100,
    dmxMode: 'solid'
  });

  const frameFull = logic.computeDmxFrame(baseCfg, whiteSolidSync, { phase: 0, beatIndex: 0 }, { bass: 0.9, mid: 0.5, high: 0.3 }, 0);
  assert.ok(frameFull.channels instanceof Uint8Array);
  assert.equal(frameFull.channels.length, 512);
  assert.equal(frameFull.previews.length, 6);

  // 'rgb' (idx 0..2)
  assert.deepEqual(Array.from(frameFull.channels.subarray(0, 3)), [255, 255, 255]);
  // 'rgbw' (idx 9..12)
  assert.deepEqual(Array.from(frameFull.channels.subarray(9, 13)), [255, 255, 255, 255]);
  // 'drgb' (idx 19..22): Dim=255, R=255, G=255, B=255
  assert.deepEqual(Array.from(frameFull.channels.subarray(19, 23)), [255, 255, 255, 255]);
  // 'drgbs' (idx 29..33): Dim,R,G,B,Strobe(=0 ở solid)
  assert.deepEqual(Array.from(frameFull.channels.subarray(29, 34)), [255, 255, 255, 255, 0]);
  // 'drgbws' (idx 39..44): Dim,R,G,B,W,Strobe
  assert.deepEqual(Array.from(frameFull.channels.subarray(39, 45)), [255, 255, 255, 255, 255, 0]);
  // 'strobe' (idx 49..50): Dim=255, Strobe=0
  assert.deepEqual(Array.from(frameFull.channels.subarray(49, 51)), [255, 0]);

  // Kiểm tra masterDimmer = 50%
  const halfCfg = { ...baseCfg, masterDimmer: 50 };
  const frameHalf = logic.computeDmxFrame(halfCfg, whiteSolidSync, { phase: 0, beatIndex: 0 }, { bass: 0.9 }, 0);
  assert.ok(frameHalf.channels[0] >= 127 && frameHalf.channels[0] <= 128);
  assert.ok(frameHalf.channels[19] >= 127 && frameHalf.channels[19] <= 128);
  assert.ok(Math.abs(frameHalf.previews[0].dimmer - 0.5) < 0.02);

  // Kiểm tra blackout = true
  const blackCfg = { ...baseCfg, blackout: true };
  const frameBlack = logic.computeDmxFrame(blackCfg, whiteSolidSync, { phase: 0, beatIndex: 0 }, { bass: 1 }, 0);
  assert.equal(frameBlack.channels.reduce((a, b) => a + b, 0), 0);
  assert.equal(frameBlack.previews.every((p) => p.dimmer === 0 && p.r === 0 && p.g === 0 && p.b === 0), true);

  // Kiểm tra các DMX mode khác: strobe, chase, rainbow-beat, bass-dimmer, beat-flash
  const strobeSync = logic.createDefaultLedSync({ on: true, dmxMode: 'strobe', intensity: 100 });
  const frameStrobe = logic.computeDmxFrame(baseCfg, strobeSync, { phase: 0, beatIndex: 0 }, { bass: 0 }, 0);
  assert.ok(frameStrobe.channels[33] > 128); // drgbs Strobe ch
  assert.ok(frameStrobe.channels[50] > 128); // strobe Strobe ch

  const bassSync = logic.createDefaultLedSync({ on: true, dmxMode: 'bass-dimmer', intensity: 100, palette: 'white' });
  const frameBassLow = logic.computeDmxFrame(baseCfg, bassSync, { phase: 0, beatIndex: 0 }, { bass: 0 }, 0);
  const frameBassHigh = logic.computeDmxFrame(baseCfg, bassSync, { phase: 0, beatIndex: 0 }, { bass: 1 }, 0);
  assert.equal(frameBassLow.channels[19], 0);
  assert.equal(frameBassHigh.channels[19], 255);

  for (const mode of ['beat-flash', 'chase', 'rainbow-beat']) {
    const sync = logic.createDefaultLedSync({ on: true, dmxMode: mode, intensity: 90 });
    const res = logic.computeDmxFrame(baseCfg, sync, { phase: 0.1, beatIndex: 2 }, { bass: 0.7 }, 1200);
    assert.equal(res.channels.length, 512);
    assert.equal(res.previews.length, 6);
  }
});

test('validateAndMigrateProject: di trú mượt v1 -> v2 không cảnh báo, giữ nguyên cue cũ & bổ sung đầy đủ cấu trúc v3.0 Pro', () => {
  const v1 = {
    version: 1,
    cues: [
      { id: 'c1', name: 'Intro', vis: 'intro.mp4', fx: { on: true, scale: 10 } }
    ]
  };

  const resV1 = logic.validateAndMigrateProject(v1);
  assert.equal(resV1.ok, true);
  assert.equal(resV1.warnings.length, 0);
  assert.equal(resV1.project.version, 2);
  assert.equal(resV1.project.cues[0].id, 'c1');
  assert.equal(resV1.project.cues[0].sourceType, 'media');
  assert.equal(resV1.project.cues[0].cameraId, '');
  assert.equal(resV1.project.cues[0].generator, 'laser-beams');
  assert.equal(resV1.project.cues[0].ledSync.mode, 'edge-chase');
  assert.ok(resV1.project.overlays && resV1.project.overlays.ov1 && resV1.project.overlays.ov4);
  assert.ok(resV1.project.vjDeck && resV1.project.vjDeck.decks.length === 3);
  assert.ok(resV1.project.masterFx && resV1.project.masterFx.dimmer === 100);
  assert.ok(resV1.project.outputMapping && resV1.project.outputMapping.perspective === 1200);
  assert.ok(resV1.project.dmxConfig && resV1.project.dmxConfig.fixtures.length === 8);
  assert.deepEqual(resV1.project.oscConfig, { enabled: false, port: 9000 });

  // Dự án v2 cũng không phát sinh warning phiên bản
  const v2 = {
    version: 2,
    cues: [logic.createDefaultCue({ name: 'Gen', sourceType: 'generator', generator: 'plasma-wave' })],
    oscConfig: { enabled: true, port: 9005 }
  };
  const resV2 = logic.validateAndMigrateProject(v2);
  assert.equal(resV2.ok, true);
  assert.equal(resV2.warnings.length, 0);
  assert.equal(resV2.project.version, 2);
  assert.equal(resV2.project.cues[0].sourceType, 'generator');
  assert.equal(resV2.project.cues[0].generator, 'plasma-wave');
  assert.deepEqual(resV2.project.oscConfig, { enabled: true, port: 9005 });
});
