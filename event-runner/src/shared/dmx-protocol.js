/**
 * Giao thức truyền DMX qua mạng Ethernet cho EVENT RUNNER v3.0 Pro:
 * - Art-Net (UDP 6454, gói ArtDmx 530 byte)
 * - sACN / ANSI E1.31 (UDP 5568, gói Data 638 byte + địa chỉ multicast 239.255.H.L)
 */
'use strict';

const crypto = require('crypto');

const ARTNET_HEADER = Buffer.from('Art-Net\0', 'ascii');
const ARTNET_OPCODE_DMX = 0x5000;
const ARTNET_PROTOCOL_VERSION = 14; // 0x000e

const SACN_ACN_IDENTIFIER = Buffer.from([
  0x41, 0x53, 0x43, 0x2d, // "ASC-"
  0x45, 0x31, 0x2e, 0x31, // "E1.1"
  0x37, 0x00, 0x00, 0x00  // "7\0\0\0"
]);
const SACN_DEFAULT_CID = crypto.randomBytes(16);
// Đánh dấu chuẩn UUID v4 cho CID mặc định
SACN_DEFAULT_CID[6] = (SACN_DEFAULT_CID[6] & 0x0f) | 0x40;
SACN_DEFAULT_CID[8] = (SACN_DEFAULT_CID[8] & 0x3f) | 0x80;

/**
 * Ghi tối đa 512 kênh DMX vào buffer đích tại vị trí offset
 */
function copyDmxChannels(dest, offset, channels) {
  if (!channels || typeof channels.length !== 'number') return;
  const count = Math.min(512, channels.length);
  for (let i = 0; i < count; i++) {
    const raw = Number(channels[i]);
    if (!Number.isFinite(raw) || raw <= 0) {
      dest[offset + i] = 0;
    } else if (raw >= 255) {
      dest[offset + i] = 255;
    } else {
      dest[offset + i] = Math.round(raw);
    }
  }
}

/**
 * Tạo gói Art-Net ArtDmx (530 byte)
 * @param {number} universe - Universe Art-Net 0..32767 (16-bit LE)
 * @param {Uint8Array|number[]} channels - Tối đa 512 giá trị kênh (0..255)
 * @param {number} [sequence=1] - Số thứ tự gói 1..255
 * @returns {Buffer}
 */
function buildArtNetPacket(universe = 0, channels = null, sequence = 1) {
  const buf = Buffer.alloc(530);

  // 0..7: "Art-Net\0"
  ARTNET_HEADER.copy(buf, 0);
  // 8..9: OpCode 0x5000 (little-endian)
  buf.writeUInt16LE(ARTNET_OPCODE_DMX, 8);
  // 10..11: ProtVer 0x000e (big-endian)
  buf.writeUInt16BE(ARTNET_PROTOCOL_VERSION, 10);

  // 12: Sequence 1..255
  const rawSeq = Math.floor(Number(sequence));
  const seq = !Number.isFinite(rawSeq) || rawSeq <= 0 ? 1 : ((rawSeq - 1) % 255) + 1;
  buf[12] = seq;

  // 13: Physical = 0
  buf[13] = 0;

  // 14..15: Universe (SubUni + Net, 16-bit LE)
  const rawUni = Math.floor(Number(universe));
  const uni = Number.isFinite(rawUni) ? Math.min(32767, Math.max(0, rawUni)) : 0;
  buf.writeUInt16LE(uni, 14);

  // 16..17: Độ dài dữ liệu DMX = 512 (0x0200 BE)
  buf.writeUInt16BE(512, 16);

  // 18..529: 512 byte DMX
  copyDmxChannels(buf, 18, channels);

  return buf;
}

/**
 * Tạo gói E1.31 sACN Data (638 byte: Root Layer + Framing Layer + DMP Layer)
 * @param {number} universe - Universe sACN 1..63999
 * @param {Uint8Array|number[]} channels - Tối đa 512 giá trị kênh (0..255)
 * @param {number} [sequence=0] - Số thứ tự gói 0..255
 * @param {string} [sourceName='EVENT RUNNER v3'] - Tên nguồn phát (tối đa 63 byte UTF-8)
 * @param {Buffer|Uint8Array} [cidBytes] - CID 16 byte (tùy chọn)
 * @returns {Buffer}
 */
function buildSacnPacket(universe = 1, channels = null, sequence = 0, sourceName = 'EVENT RUNNER v3', cidBytes = null) {
  const buf = Buffer.alloc(638);

  // --- Root Layer (38 byte: 0..37) ---
  buf.writeUInt16BE(0x0010, 0); // Preamble Size
  buf.writeUInt16BE(0x0000, 2); // Post-amble Size
  SACN_ACN_IDENTIFIER.copy(buf, 4); // 4..15: "ASC-E1.17\0\0\0"
  buf.writeUInt16BE(0x7000 | (638 - 16), 16); // Flags & Length = 0x726e
  buf.writeUInt32BE(0x00000004, 18); // Vector = VECTOR_ROOT_E131_DATA

  // 22..37: CID 16 byte
  if (cidBytes && typeof cidBytes.length === 'number' && cidBytes.length >= 16) {
    for (let i = 0; i < 16; i++) {
      buf[22 + i] = cidBytes[i] & 0xff;
    }
  } else {
    SACN_DEFAULT_CID.copy(buf, 22);
  }

  // --- Framing Layer (77 byte: 38..114) ---
  buf.writeUInt16BE(0x7000 | (638 - 38), 38); // Flags & Length = 0x7258
  buf.writeUInt32BE(0x00000002, 40); // Vector = VECTOR_E131_DATA_PACKET

  // 44..107: Source Name (64 byte, null-terminated)
  const srcText = typeof sourceName === 'string' && sourceName.trim() ? sourceName.trim() : 'EVENT RUNNER v3';
  const nameBuf = Buffer.from(srcText, 'utf8');
  nameBuf.copy(buf, 44, 0, Math.min(63, nameBuf.length));

  buf[108] = 100; // Priority = 100
  buf.writeUInt16BE(0x0000, 109); // Synchronization Address = 0
  buf[111] = (Math.floor(Number(sequence) || 0)) & 0xff; // Sequence Number
  buf[112] = 0x00; // Options

  const rawUni = Math.floor(Number(universe));
  const uni = Number.isFinite(rawUni) ? Math.min(63999, Math.max(1, rawUni)) : 1;
  buf.writeUInt16BE(uni, 113); // Universe (1..63999, big-endian)

  // --- DMP Layer (523 byte: 115..637) ---
  buf.writeUInt16BE(0x7000 | (638 - 115), 115); // Flags & Length = 0x720b
  buf[117] = 0x02; // Vector = VECTOR_DMP_SET_PROPERTY
  buf[118] = 0xa1; // Address Type & Data Type
  buf.writeUInt16BE(0x0000, 119); // First Property Address
  buf.writeUInt16BE(0x0001, 121); // Address Increment
  buf.writeUInt16BE(513, 123); // Property value count (1 start code + 512 slots)
  buf[125] = 0x00; // DMX Start Code = 0x00

  // 126..637: 512 byte DMX
  copyDmxChannels(buf, 126, channels);

  return buf;
}

/**
 * Tính địa chỉ IP multicast chuẩn E1.31 cho universe sACN (1..63999)
 * @param {number} universe
 * @returns {string}
 */
function getSacnMulticastIp(universe) {
  const rawUni = Math.floor(Number(universe));
  const u = Number.isFinite(rawUni) ? Math.min(63999, Math.max(1, rawUni)) : 1;
  return '239.255.' + ((u >> 8) & 0xff) + '.' + (u & 0xff);
}

module.exports = {
  buildArtNetPacket,
  buildSacnPacket,
  getSacnMulticastIp
};
