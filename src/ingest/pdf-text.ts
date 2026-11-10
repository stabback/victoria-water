import { getDocumentProxy } from "unpdf";

/**
 * Text of each PDF page, rebuilt into visual lines.
 *
 * TRAP: pdf.js returns text items in content-stream order, which for the Water Watch reports
 * puts table numbers far away from their row labels. Grouping items by baseline (y) and then
 * sorting by x restores the printed layout, so "Sooke 70,693 61,216 53,272 57.5%" is one line.
 */
export async function pdfPageLines(data: Uint8Array): Promise<string[][]> {
  const pdf = await getDocumentProxy(data, { verbosity: 0 });
  const pages: string[][] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const items: { s: string; x: number; y: number }[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      items.push({ s: item.str.trim(), x: item.transform[4] as number, y: item.transform[5] as number });
    }
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: (typeof items)[] = [];
    for (const item of items) {
      const line = lines.at(-1);
      if (line && Math.abs((line[0] as (typeof items)[number]).y - item.y) < 3) line.push(item);
      else lines.push([item]);
    }
    pages.push(
      lines.map((l) =>
        l
          .sort((a, b) => a.x - b.x)
          .map((i) => i.s)
          .join(" ")
          .replace(/\s+/g, " "),
      ),
    );
    page.cleanup();
  }
  await pdf.cleanup();
  return pages;
}
