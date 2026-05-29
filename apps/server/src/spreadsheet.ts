import { inflateRawSync } from "node:zlib";

export interface SpreadsheetRecord {
  [header: string]: string;
}

export function parseSpreadsheet(buffer: Buffer, filename = ""): SpreadsheetRecord[] {
  const lowerName = filename.toLowerCase();

  if (lowerName.endsWith(".xlsx") || isZipBuffer(buffer)) {
    return rowsToRecords(parseXlsxRows(buffer));
  }

  return rowsToRecords(parseDelimitedRows(buffer.toString("utf8")));
}

function parseXlsxRows(buffer: Buffer) {
  const entries = readZipEntries(buffer);
  const sheet = entries.get("xl/worksheets/sheet1.xml");

  if (!sheet) {
    throw new Error("Excel 模板缺少第一张工作表");
  }

  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml"));
  const xml = sheet.toString("utf8");
  const rows: string[][] = [];

  for (const rowMatch of xml.matchAll(/<row\b[^>]*>[\s\S]*?<\/row>/g)) {
    const rowXml = rowMatch[0];
    const values: string[] = [];

    for (const cellMatch of rowXml.matchAll(/<c\b[^>]*>[\s\S]*?<\/c>/g)) {
      const cellXml = cellMatch[0];
      const ref = cellXml.match(/\br="([A-Z]+)\d+"/);
      const column = ref ? columnNameToIndex(ref[1]) : values.length;
      values[column] = readCellValue(cellXml, sharedStrings);
    }

    rows.push(values);
  }

  return rows;
}

function parseSharedStrings(buffer?: Buffer) {
  if (!buffer) {
    return [];
  }

  const xml = buffer.toString("utf8");
  const strings: string[] = [];

  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const parts = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((item) => decodeXml(item[1]));
    strings.push(parts.join(""));
  }

  return strings;
}

function readCellValue(cellXml: string, sharedStrings: string[]) {
  if (/\bt="inlineStr"/.test(cellXml)) {
    const inline = cellXml.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
    return inline ? decodeXml(inline[1]).trim() : "";
  }

  const value = cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);

  if (!value) {
    return "";
  }

  const text = decodeXml(value[1]).trim();

  if (/\bt="s"/.test(cellXml)) {
    return sharedStrings[Number(text)] ?? "";
  }

  return text;
}

function readZipEntries(buffer: Buffer) {
  const entries = new Map<string, Buffer>();
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);

  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Excel 文件结构异常");
    }

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + fileNameLength);
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      entries.set(name, Buffer.from(compressed));
    } else if (method === 8) {
      entries.set(name, inflateRawSync(compressed));
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer) {
  const minOffset = Math.max(0, buffer.length - 65557);

  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }

  throw new Error("无法识别 Excel 文件");
}

function parseDelimitedRows(text: string) {
  const cleanText = text.replace(/^\uFEFF/, "");
  const firstLine = cleanText.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  return cleanText
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => parseDelimitedLine(line, delimiter));
}

function parseDelimitedLine(line: string, delimiter: string) {
  const values: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"" && inQuotes && next === "\"") {
      value += "\"";
      index += 1;
      continue;
    }

    if (char === "\"") {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      values.push(value.trim());
      value = "";
      continue;
    }

    value += char;
  }

  values.push(value.trim());
  return values;
}

function rowsToRecords(rows: string[][]): SpreadsheetRecord[] {
  const headerRow = rows.find((row) => row.some((value) => value.trim()));

  if (!headerRow) {
    return [];
  }

  const headers = headerRow.map((value) => value.trim());
  const startIndex = rows.indexOf(headerRow) + 1;

  return rows.slice(startIndex).flatMap((row) => {
    if (!row.some((value) => value.trim())) {
      return [];
    }

    const record: SpreadsheetRecord = {};

    headers.forEach((header, index) => {
      if (header) {
        record[header] = row[index]?.trim() ?? "";
      }
    });

    return [record];
  });
}

function columnNameToIndex(columnName: string) {
  return columnName.split("").reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function isZipBuffer(buffer: Buffer) {
  return buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
}
