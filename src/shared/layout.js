function greatestCommonDivisor(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

function leastCommonMultiple(left, right) {
  return Math.abs(left * right) / greatestCommonDivisor(left, right);
}

function distributeRows(count, rows) {
  const base = Math.floor(count / rows);
  const extra = count % rows;
  // Rows with fewer tiles come first so the leading (main) streams get the
  // larger tiles, e.g. 5 tiles on a 16:9 screen become 2 on top and 3 below.
  return Array.from({ length: rows }, (_, index) =>
    index < rows - extra ? base : base + 1,
  );
}

/**
 * Splits tiles across rows so every row spans the full width with no empty
 * cell. Row counts differ by at most one, rows with fewer (larger) tiles come
 * first, and the row count maximizing the total 16:9 video area is chosen.
 */
export function createMosaicLayout(itemCount, width, height) {
  const count = Math.max(0, Math.floor(Number(itemCount) || 0));
  if (count === 0) {
    return { rows: 1, rowCounts: [], trackColumns: 1, spans: [] };
  }

  const safeWidth = Math.max(1, Number(width) || 0);
  const safeHeight = Math.max(1, Number(height) || 0);
  let best = null;
  for (let rows = 1; rows <= count; rows += 1) {
    const rowCounts = distributeRows(count, rows);
    const rowHeight = safeHeight / rows;
    let area = 0;
    for (const rowCount of rowCounts) {
      const cellWidth = safeWidth / rowCount;
      const videoWidth = Math.min(cellWidth, rowHeight * (16 / 9));
      const videoHeight = Math.min(rowHeight, cellWidth * (9 / 16));
      area += rowCount * videoWidth * videoHeight;
    }
    if (!best || area > best.area) best = { rows, rowCounts, area };
  }

  const trackColumns = best.rowCounts.reduce(
    (acc, rowCount) => leastCommonMultiple(acc, rowCount),
    1,
  );
  const spans = best.rowCounts.flatMap((rowCount) =>
    Array(rowCount).fill(trackColumns / rowCount),
  );
  return {
    rows: best.rows,
    rowCounts: best.rowCounts,
    trackColumns,
    spans,
  };
}

/**
 * Builds a grid that can optionally stretch an incomplete final row across
 * the full width. The returned spans use a shared internal column count, so
 * rows with different item counts still meet without leaving an empty cell.
 */
export function createGridLayout(itemCount, requestedColumns, fillLastRow = false) {
  const count = Math.max(0, Math.floor(Number(itemCount) || 0));
  if (count === 0) {
    return { columns: 1, rows: 1, trackColumns: 1, spans: [] };
  }

  const columns = Math.max(1, Math.min(Math.floor(Number(requestedColumns) || 1), count));
  const rows = Math.ceil(count / columns);
  if (!fillLastRow) {
    return {
      columns,
      rows,
      trackColumns: columns,
      spans: Array(count).fill(1),
    };
  }

  const finalRowCount = count - columns * (rows - 1);
  const trackColumns = leastCommonMultiple(columns, finalRowCount);
  const regularSpan = trackColumns / columns;
  const finalRowSpan = trackColumns / finalRowCount;
  const finalRowStart = columns * (rows - 1);
  const spans = Array.from(
    { length: count },
    (_, index) => index < finalRowStart ? regularSpan : finalRowSpan,
  );

  return { columns, rows, trackColumns, spans };
}
