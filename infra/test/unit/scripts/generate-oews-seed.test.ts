import ExcelJS from 'exceljs';

import { sheetRows } from '../../../scripts/generate-oews-seed';

/**
 * sheetRows is the single point where a downloaded .xlsx becomes the
 * array-of-arrays that lib/oews-bulk-parser.ts and lib/census-crosswalk-parser.ts
 * consume (header row included, 0-indexed, one entry per column). Those two
 * parsers already have their own tests against hand-built fixtures; what was
 * never covered is the conversion itself, which is exactly the part that
 * changes when the spreadsheet library does.
 *
 * Fixtures here are built in memory with exceljs and never touch the real BLS
 * or Census files -- the OEWS bulk file is a ~79 MB download this suite must
 * never trigger.
 */

async function workbookBuffer(
  build: (workbook: ExcelJS.Workbook) => void,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('generate-oews-seed: sheetRows', () => {
  it('turns the first worksheet into 0-indexed rows, header included, preserving cell types', async () => {
    const buf = await workbookBuffer((workbook) => {
      const sheet = workbook.addWorksheet('all_data_M_2025');
      // Mirrors the real BLS layout this feeds: text area/occ codes in the
      // left columns, numeric hourly wages on the right.
      sheet.addRow(['AREA', 'AREA_TITLE', 'OCC_CODE', 'H_PCT25', 'H_MEDIAN']);
      sheet.addRow(['12420', 'Austin-Round Rock-San Marcos, TX', '47-2111', 22.97, 29.03]);
      sheet.addRow(['48', 'Texas', '47-2081', 20.5, 26]);
    });

    const rows = await sheetRows(buf);

    expect(rows).toEqual([
      ['AREA', 'AREA_TITLE', 'OCC_CODE', 'H_PCT25', 'H_MEDIAN'],
      ['12420', 'Austin-Round Rock-San Marcos, TX', '47-2111', 22.97, 29.03],
      ['48', 'Texas', '47-2081', 20.5, 26],
    ]);
    // Types matter to parseOewsBulkRows: it drops any row whose AREA/OCC_CODE
    // is not a string, and parses wages from numbers or numeric strings.
    expect(typeof rows[1][0]).toBe('string');
    expect(typeof rows[1][3]).toBe('number');
    expect(typeof rows[2][4]).toBe('number');
  });

  it('keeps an empty cell as a hole so column positions after it do not shift', async () => {
    const buf = await workbookBuffer((workbook) => {
      const sheet = workbook.addWorksheet('sheet');
      sheet.addRow(['A', 'B', 'C', 'D']);
      const row = sheet.addRow([]);
      row.getCell(1).value = '12420';
      // cell 2 deliberately left empty -- BLS suppresses cells routinely
      row.getCell(3).value = 'Austin';
      row.getCell(4).value = 31.5;
    });

    const rows = await sheetRows(buf);

    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe('12420');
    expect(rows[1][1]).toBeUndefined();
    expect(rows[1][2]).toBe('Austin');
    expect(rows[1][3]).toBe(31.5);
  });

  it('normalises the rich cell objects a real workbook can carry into plain values', async () => {
    const buf = await workbookBuffer((workbook) => {
      const sheet = workbook.addWorksheet('sheet');
      sheet.addRow(['PLAIN', 'FORMULA', 'RICH', 'WHEN', 'FLAG']);
      const row = sheet.addRow([]);
      row.getCell(1).value = 'Texas';
      // A formula cell reads back as { formula, result } -- the cached result
      // is the number the parser needs, not the formula text.
      row.getCell(2).value = { formula: 'SUM(1,2)', result: 28.16 };
      // Styled runs inside one cell read back as { richText: [...] }.
      row.getCell(3).value = { richText: [{ text: 'Cement ' }, { text: 'Masons' }] };
      row.getCell(4).value = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
      row.getCell(5).value = true;
    });

    const rows = await sheetRows(buf);

    expect(rows[1][0]).toBe('Texas');
    expect(rows[1][1]).toBe(28.16);
    expect(rows[1][2]).toBe('Cement Masons');
    expect(rows[1][3]).toBe('2026-01-15T12:00:00.000Z');
    expect(rows[1][4]).toBe(true);
  });

  it('returns an empty result for a workbook with no worksheet rather than throwing', async () => {
    const buf = await workbookBuffer(() => {
      // no worksheet added at all
    });

    await expect(sheetRows(buf)).resolves.toEqual([]);
  });
});
