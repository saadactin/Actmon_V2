/**
 * Renders the cost report as a paginated data table directly with jsPDF
 * primitives (no jspdf-autotable dependency in this project). A PDF is meant
 * to be a readable report, not a full data dump — capped at MAX_PDF_ROWS;
 * the CSV export carries the complete filtered dataset with no cap.
 */
export const MAX_PDF_ROWS = 2000;

export interface PdfColumn {
  key: string;
  label: string;
  width: number; // mm
  align?: 'left' | 'right';
}

export async function downloadCostReportPdf(
  filename: string,
  title: string,
  subtitle: string,
  columns: PdfColumn[],
  rows: Record<string, unknown>[],
): Promise<{ truncated: boolean; rowsWritten: number }> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  const pageW = 297, pageH = 210;
  const marginX = 10, marginTop = 15, marginBottom = 10;
  const rowHeight = 6, headerHeight = 7;
  const tableW = pageW - marginX * 2;

  let y = marginTop;

  const drawColumnHeaders = () => {
    pdf.setFillColor(37, 99, 235);
    pdf.rect(marginX, y, tableW, headerHeight, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    let x = marginX + 1.5;
    for (const col of columns) {
      pdf.text(col.label, col.align === 'right' ? x + col.width - 3 : x, y + headerHeight - 2, {
        align: col.align === 'right' ? 'right' : 'left',
        maxWidth: col.width - 2,
      });
      x += col.width;
    }
    y += headerHeight;
    pdf.setTextColor(30, 30, 30);
    pdf.setFont('helvetica', 'normal');
  };

  const newPage = () => {
    pdf.addPage();
    y = marginTop;
    drawColumnHeaders();
  };

  pdf.setFontSize(14);
  pdf.setFont('helvetica', 'bold');
  pdf.text(title, marginX, y);
  y += 6;
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'normal');
  pdf.text(subtitle, marginX, y);
  y += 6;
  drawColumnHeaders();

  const truncated = rows.length > MAX_PDF_ROWS;
  const toWrite = truncated ? rows.slice(0, MAX_PDF_ROWS) : rows;

  toWrite.forEach((row, idx) => {
    if (y + rowHeight > pageH - marginBottom) newPage();
    if (idx % 2 === 1) {
      pdf.setFillColor(245, 247, 250);
      pdf.rect(marginX, y, tableW, rowHeight, 'F');
    }
    let x = marginX + 1.5;
    pdf.setFontSize(7.5);
    for (const col of columns) {
      const raw = row[col.key];
      const text = raw == null ? '' : String(raw);
      const xPos = col.align === 'right' ? x + col.width - 3 : x;
      pdf.text(text, xPos, y + rowHeight - 1.8, {
        align: col.align === 'right' ? 'right' : 'left',
        maxWidth: col.width - 2,
      });
      x += col.width;
    }
    y += rowHeight;
  });

  if (truncated) {
    if (y + rowHeight > pageH - marginBottom) newPage();
    pdf.setFont('helvetica', 'italic');
    pdf.setTextColor(180, 60, 20);
    pdf.text(
      `Truncated to the first ${MAX_PDF_ROWS} of ${rows.length} rows (sorted by date, then cost). Use the CSV export for the complete dataset.`,
      marginX, y + rowHeight - 1.8,
    );
  }

  const pageCount = pdf.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    pdf.setPage(i);
    pdf.setFontSize(7);
    pdf.setTextColor(120, 120, 120);
    pdf.setFont('helvetica', 'normal');
    pdf.text(`Page ${i} of ${pageCount}`, pageW - marginX, pageH - 4, { align: 'right' });
  }

  pdf.save(filename);
  return { truncated, rowsWritten: toWrite.length };
}
