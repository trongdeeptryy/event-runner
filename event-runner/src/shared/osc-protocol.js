/**
 * Bộ phân tích và đóng gói giao thức OSC 1.0 nhị phân (Open Sound Control)
 * Hỗ trợ gói đơn, #bundle đệ quy và đầy đủ các kiểu dữ liệu (i, f, s, b, T, F, N, I).
 * Bộ phân tích an toàn tuyệt đối: không bao giờ ném ngoại lệ với dữ liệu lỗi/cắt cụt.
 */
'use strict';

const MAX_BUNDLE_DEPTH = 16;

/**
 * Mã hóa chuỗi UTF-8 kết thúc bằng null và căn lề bội số 4 byte theo chuẩn OSC
 * @param {string} str
 * @returns {Buffer}
 */
function encodeOscString(str) {
  const raw = Buffer.from(String(str), 'utf8');
  const paddedLen = (raw.length + 4) & ~3;
  const out = Buffer.alloc(paddedLen);
  raw.copy(out, 0);
  return out;
}

/**
 * Đọc chuỗi OSC căn lề 4 byte trong đoạn [offset, end)
 * Trả về null nếu thiếu ký tự null kết thúc hoặc bị cắt cụt trước ranh giới 4 byte.
 */
function readOscString(buf, offset, end) {
  if (offset < 0 || offset >= end) return null;
  const nulIdx = buf.indexOf(0x00, offset);
  if (nulIdx === -1 || nulIdx >= end) return null;

  const value = buf.toString('utf8', offset, nulIdx);
  const rawLen = nulIdx - offset + 1;
  const paddedLen = (rawLen + 3) & ~3;
  const nextOffset = offset + paddedLen;
  if (nextOffset > end) return null;

  return { value, nextOffset };
}

/**
 * Phân tích một thông điệp OSC đơn lẻ trong phạm vi [start, end)
 */
function parseOscMessage(buf, start, end) {
  const addrRes = readOscString(buf, start, end);
  if (!addrRes || !addrRes.value.startsWith('/')) return null;

  let pos = addrRes.nextOffset;
  if (pos >= end) {
    return { address: addrRes.value, args: [] };
  }

  const tagRes = readOscString(buf, pos, end);
  if (!tagRes || !tagRes.value.startsWith(',')) return null;

  pos = tagRes.nextOffset;
  const tags = tagRes.value.slice(1);
  const args = [];

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (tag === 'i') {
      if (pos + 4 > end) return null;
      args.push(buf.readInt32BE(pos));
      pos += 4;
    } else if (tag === 'f') {
      if (pos + 4 > end) return null;
      args.push(buf.readFloatBE(pos));
      pos += 4;
    } else if (tag === 's') {
      const sRes = readOscString(buf, pos, end);
      if (!sRes) return null;
      args.push(sRes.value);
      pos = sRes.nextOffset;
    } else if (tag === 'b') {
      if (pos + 4 > end) return null;
      const blobLen = buf.readInt32BE(pos);
      pos += 4;
      if (blobLen < 0 || pos + blobLen > end) return null;
      const paddedLen = (blobLen + 3) & ~3;
      if (pos + paddedLen > end) return null;
      args.push(Buffer.from(buf.subarray(pos, pos + blobLen)));
      pos += paddedLen;
    } else if (tag === 'T') {
      args.push(true);
    } else if (tag === 'F') {
      args.push(false);
    } else if (tag === 'N') {
      args.push(null);
    } else if (tag === 'I') {
      args.push(Infinity);
    } else if (tag === 'd') {
      if (pos + 8 > end) return null;
      args.push(buf.readDoubleBE(pos));
      pos += 8;
    } else if (tag === 'h') {
      if (pos + 8 > end) return null;
      args.push(Number(buf.readBigInt64BE(pos)));
      pos += 8;
    } else {
      return null;
    }
  }

  return { address: addrRes.value, args };
}

/**
 * Phân tích đệ quy gói OSC (hỗ trợ cả #bundle và thông điệp đơn)
 */
function parseOscSlice(buf, start, end, depth, out) {
  if (depth > MAX_BUNDLE_DEPTH || start < 0 || start >= end) return;

  // Kiểm tra tiêu đề "#bundle\0" (8 byte) + timetag (8 byte)
  if (
    end - start >= 16 &&
    buf[start] === 0x23 && // '#'
    buf.toString('ascii', start, start + 8) === '#bundle\0'
  ) {
    let pos = start + 16; // Bỏ qua "#bundle\0" và 8 byte OSC timetag
    while (pos + 4 <= end) {
      const elemSize = buf.readInt32BE(pos);
      pos += 4;
      if (elemSize <= 0 || pos + elemSize > end) break;
      parseOscSlice(buf, pos, pos + elemSize, depth + 1, out);
      pos += elemSize;
    }
    return;
  }

  const msg = parseOscMessage(buf, start, end);
  if (msg) {
    out.push(msg);
  }
}

/**
 * Phân tích gói Buffer OSC nhận từ UDP thành danh sách { address, args }.
 * Không bao giờ ném lỗi ngay cả khi buffer bị hỏng hoặc cắt cụt.
 * @param {Buffer|Uint8Array} buf
 * @returns {Array<{ address: string, args: Array<number|string|boolean|Buffer|null> }>}
 */
function parseOscPacket(buf) {
  try {
    let buffer = null;
    if (Buffer.isBuffer(buf)) {
      buffer = buf;
    } else if (buf instanceof Uint8Array) {
      buffer = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    } else {
      return [];
    }

    if (buffer.length === 0) return [];
    const out = [];
    parseOscSlice(buffer, 0, buffer.length, 0, out);
    return out;
  } catch (_err) {
    return [];
  }
}

/**
 * Đóng gói một thông điệp OSC nhị phân theo chuẩn căn lề 4 byte
 * @param {string} address - Địa chỉ OSC (ví dụ '/er/go')
 * @param {Array} [args=[]] - Mảng tham số
 * @returns {Buffer}
 */
function buildOscPacket(address, args = []) {
  let addr = typeof address === 'string' && address.trim() ? address.trim() : '/';
  if (!addr.startsWith('/') && addr !== '#bundle') {
    addr = '/' + addr;
  }

  const addrBuf = encodeOscString(addr);
  const argList = Array.isArray(args) ? args : [];
  let tags = ',';
  const payloadChunks = [];

  for (let i = 0; i < argList.length; i++) {
    const arg = argList[i];

    if (arg && typeof arg === 'object' && !Buffer.isBuffer(arg) && !(arg instanceof Uint8Array) && typeof arg.type === 'string') {
      const t = arg.type;
      const v = arg.value;
      if (t === 'i') {
        tags += 'i';
        const b = Buffer.alloc(4);
        b.writeInt32BE(Math.trunc(Number(v) || 0), 0);
        payloadChunks.push(b);
      } else if (t === 'f') {
        tags += 'f';
        const b = Buffer.alloc(4);
        b.writeFloatBE(Number(v) || 0, 0);
        payloadChunks.push(b);
      } else if (t === 's') {
        tags += 's';
        payloadChunks.push(encodeOscString(v === undefined || v === null ? '' : String(v)));
      } else if (t === 'b') {
        tags += 'b';
        const src = Buffer.isBuffer(v) ? v : Buffer.from(v instanceof Uint8Array ? v : []);
        const paddedLen = (src.length + 3) & ~3;
        const b = Buffer.alloc(4 + paddedLen);
        b.writeInt32BE(src.length, 0);
        src.copy(b, 4);
        payloadChunks.push(b);
      } else if (t === 'T') {
        tags += 'T';
      } else if (t === 'F') {
        tags += 'F';
      } else if (t === 'N') {
        tags += 'N';
      } else if (t === 'I') {
        tags += 'I';
      }
      continue;
    }

    if (arg === true) {
      tags += 'T';
    } else if (arg === false) {
      tags += 'F';
    } else if (arg === null || arg === undefined) {
      tags += 'N';
    } else if (arg === Infinity) {
      tags += 'I';
    } else if (Buffer.isBuffer(arg) || arg instanceof Uint8Array) {
      tags += 'b';
      const src = Buffer.isBuffer(arg) ? arg : Buffer.from(arg);
      const paddedLen = (src.length + 3) & ~3;
      const b = Buffer.alloc(4 + paddedLen);
      b.writeInt32BE(src.length, 0);
      src.copy(b, 4);
      payloadChunks.push(b);
    } else if (typeof arg === 'number') {
      if (Number.isInteger(arg) && arg >= -2147483648 && arg <= 2147483647) {
        tags += 'i';
        const b = Buffer.alloc(4);
        b.writeInt32BE(arg, 0);
        payloadChunks.push(b);
      } else {
        tags += 'f';
        const b = Buffer.alloc(4);
        b.writeFloatBE(arg, 0);
        payloadChunks.push(b);
      }
    } else {
      tags += 's';
      payloadChunks.push(encodeOscString(String(arg)));
    }
  }

  const tagBuf = encodeOscString(tags);
  return Buffer.concat([addrBuf, tagBuf, ...payloadChunks]);
}

/**
 * Đóng gói nhiều gói OSC con thành một #bundle chuẩn OSC 1.0
 * @param {Buffer[]} packets
 * @returns {Buffer}
 */
function buildOscBundle(packets = []) {
  const header = Buffer.alloc(16);
  Buffer.from('#bundle\0', 'ascii').copy(header, 0);
  // Timetag immediate = 0x0000000000000001
  header.writeUInt32BE(0, 8);
  header.writeUInt32BE(1, 12);

  const parts = [header];
  if (Array.isArray(packets)) {
    for (let i = 0; i < packets.length; i++) {
      const p = packets[i];
      if (!Buffer.isBuffer(p) || p.length === 0) continue;
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeInt32BE(p.length, 0);
      parts.push(lenBuf, p);
    }
  }
  return Buffer.concat(parts);
}

module.exports = {
  parseOscPacket,
  buildOscPacket,
  buildOscBundle
};
