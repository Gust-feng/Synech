import { inflateRawSync } from "node:zlib";

const MAX_ZIP_ENTRIES = 1_000;
const MAX_SPREADSHEET_ENTRY_BYTES = 4 * 1024 * 1024;

export type ZipEntry = {
  readonly name: string;
  readonly flags: number;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
};

/** Reads ZIP central-directory facts without extracting any entry. */
export function readZipEntries(buffer: Buffer): readonly ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset === undefined) {
    throw new Error("xlsx_zip_directory_missing");
  }
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("unsupported_zip64");
  }
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error("zip_entry_limit_exceeded");
  }
  if (centralDirectoryOffset + centralDirectorySize > buffer.length) {
    throw new Error("xlsx_zip_directory_invalid");
  }
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("xlsx_zip_directory_invalid");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > buffer.length) {
      throw new Error("xlsx_zip_directory_invalid");
    }
    entries.push({
      name: buffer.subarray(nameStart, nameEnd).toString("utf8"),
      flags,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

export function readZipTextEntry(buffer: Buffer, entry: ZipEntry): string {
  return readZipEntryBuffer(buffer, entry).toString("utf8");
}

export function normalizeZipEntryName(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function findEndOfCentralDirectory(buffer: Buffer): number | undefined {
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return undefined;
}

function readZipEntryBuffer(buffer: Buffer, entry: ZipEntry): Buffer {
  if ((entry.flags & 0x1) === 0x1) {
    throw new Error("unsupported_encrypted_zip");
  }
  if (entry.uncompressedSize > MAX_SPREADSHEET_ENTRY_BYTES) {
    throw new Error("spreadsheet_entry_too_large");
  }
  if (entry.localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) {
    throw new Error("xlsx_zip_entry_invalid");
  }
  const fileNameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throw new Error("xlsx_zip_entry_invalid");
  }
  const compressed = buffer.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) {
    return compressed;
  }
  if (entry.compressionMethod === 8) {
    const inflated = inflateRawSync(compressed);
    if (inflated.length > MAX_SPREADSHEET_ENTRY_BYTES) {
      throw new Error("spreadsheet_entry_too_large");
    }
    return inflated;
  }
  throw new Error("unsupported_zip_compression");
}
