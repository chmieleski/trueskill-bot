/** Discord embed field value limit (API). */
export const DISCORD_FIELD_VALUE_MAX = 1024;

/** Discord embed total character limit across title, description, fields, footer, author. */
export const DISCORD_EMBED_TOTAL_MAX = 6000;

/**
 * Target monospace line width for code-block tables inside embed fields.
 * Embed cards are ~430–490px wide on desktop and narrower on mobile; ~50 chars
 * avoids horizontal scroll in Discord's code-block font.
 */
export const DISCORD_CODE_BLOCK_TARGET_LINE_WIDTH = 50;

const ELLIPSIS = '…';

export type MonospaceTableColumn<T> = {
  header: string;
  align: 'left' | 'right';
  maxWidth: number;
  cell: (row: T) => string;
};

/** Trim embed field text to Discord's per-field limit. */
export function truncateDiscordFieldValue(value: string, max = DISCORD_FIELD_VALUE_MAX): string {
  if (value.length <= max) {
    return value;
  }
  const keep = Math.max(0, max - ELLIPSIS.length);
  return `${value.slice(0, keep)}${ELLIPSIS}`;
}

function truncateTableCell(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) {
    return text;
  }
  if (maxWidth <= 1) {
    return text.slice(0, maxWidth);
  }
  return `${text.slice(0, maxWidth - 1)}${ELLIPSIS}`;
}

function padTableCell(text: string, width: number, align: 'left' | 'right'): string {
  return align === 'left' ? text.padEnd(width) : text.padStart(width);
}

function shrinkWidthsToTarget(widths: number[], targetLineWidth: number): number[] {
  const minWidths = widths.map((width) => Math.max(1, width));
  let total = minWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, minWidths.length - 1);

  if (total <= targetLineWidth) {
    return minWidths;
  }

  const shrunk = [...minWidths];
  while (total > targetLineWidth) {
    const widestIndex = shrunk.reduce(
      (best, width, index) => (width > shrunk[best]! ? index : best),
      0,
    );
    if (shrunk[widestIndex]! <= 1) {
      break;
    }
    shrunk[widestIndex]! -= 1;
    total -= 1;
  }

  return shrunk;
}

/**
 * Render rows as an aligned monospace table inside a Discord code block.
 * Column widths are capped per column and further tightened to fit {@link DISCORD_CODE_BLOCK_TARGET_LINE_WIDTH}.
 */
export function formatMonospaceTable<T>(
  rows: T[],
  columns: MonospaceTableColumn<T>[],
  options: { maxLineWidth?: number } = {},
): string {
  if (rows.length === 0) {
    return '';
  }

  const maxLineWidth = options.maxLineWidth ?? DISCORD_CODE_BLOCK_TARGET_LINE_WIDTH;

  const naturalWidths = columns.map((column) =>
    Math.min(
      column.maxWidth,
      Math.max(column.header.length, ...rows.map((row) => column.cell(row).length)),
    ),
  );

  const widths = shrinkWidthsToTarget(naturalWidths, maxLineWidth);

  const formatRow = (cells: string[]) =>
    cells
      .map((cell, index) => {
        const column = columns[index]!;
        const clipped = truncateTableCell(cell, widths[index]!);
        return padTableCell(clipped, widths[index]!, column.align);
      })
      .join(' ');

  const header = formatRow(columns.map((column) => column.header));
  const divider = widths.map((width) => '-'.repeat(width)).join(' ');
  const body = rows.map((row) => formatRow(columns.map((column) => column.cell(row))));

  return ['```', header, divider, ...body, '```'].join('\n');
}
