// Minimal PDF 1.4 writer: A4 pages, the two standard Helvetica fonts
// (WinAnsiEncoding, so French accents work without embedding a font), simple
// vector shapes and JPEG images. Hand-written instead of pulling in jsPDF,
// whose bundle carries innerHTML code paths (rejected by the AMO linter) and
// optional dynamic imports esbuild can't resolve.
import { HELVETICA_WIDTHS, HELVETICA_BOLD_WIDTHS } from './pdf-fonts';

export interface PageSize {
  width: number;
  height: number;
}

export const A4_PORTRAIT: PageSize = { width: 595.28, height: 841.89 };
export const A4_LANDSCAPE: PageSize = { width: 841.89, height: 595.28 };

export type FontName = 'regular' | 'bold';

export interface JpegImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

// CP1252 bytes 0x80-0x9F that map to non-Latin-1 code points.
const CP1252_EXTRAS: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

function toWinAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.normalize('NFC')) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) out.push(cp);
    else if (CP1252_EXTRAS[cp] !== undefined) out.push(CP1252_EXTRAS[cp]);
    else if (cp === 0x202f || cp === 0x2009) out.push(0x20); // narrow/thin spaces (fr-FR Intl output)
    else out.push(0x3f); // '?'
  }
  return out;
}

export function textWidth(text: string, font: FontName, size: number): number {
  const table = font === 'bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let units = 0;
  for (const b of toWinAnsi(text)) units += table[b - 32] || 0;
  return (units * size) / 1000;
}

// Shortens `text` with a trailing ellipsis so it fits in `maxWidth` (with a
// small safety margin, the width table being from a metric clone).
export function fitText(text: string, font: FontName, size: number, maxWidth: number): string {
  const limit = maxWidth * 0.98;
  if (textWidth(text, font, size) <= limit) return text;
  const chars = Array.from(text);
  while (chars.length && textWidth(`${chars.join('')}…`, font, size) > limit) chars.pop();
  return `${chars.join('').trimEnd()}…`;
}

function escapePdfString(bytes: number[]): string {
  let out = '';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return out;
}

function num(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

type Rgb = [number, number, number];

function rgb(color: Rgb): string {
  return color.map((c) => num(c)).join(' ');
}

// Coordinates passed to the drawing methods are top-left based (y grows
// downwards, like the DOM); they're flipped to PDF space here.
export class PdfPage {
  readonly ops: string[] = [];
  readonly images: number[] = [];

  constructor(private readonly doc: PdfDocument) {}

  private flip(y: number): number {
    return this.doc.size.height - y;
  }

  text(
    text: string,
    x: number,
    y: number,
    opts: { font?: FontName; size?: number; color?: Rgb; align?: 'left' | 'center' | 'right'; rotate90?: boolean } = {},
  ): void {
    const font = opts.font ?? 'regular';
    const size = opts.size ?? 10;
    if (opts.rotate90) {
      // Reads bottom-to-top; (x, y) is the baseline start. align is ignored.
      this.ops.push(
        `BT ${rgb(opts.color ?? [0, 0, 0])} rg ${font === 'bold' ? '/F2' : '/F1'} ${num(size)} Tf 0 1 -1 0 ${num(x)} ${num(this.flip(y))} Tm (${escapePdfString(toWinAnsi(text))}) Tj ET`,
      );
      return;
    }
    let left = x;
    if (opts.align === 'center') left = x - textWidth(text, font, size) / 2;
    else if (opts.align === 'right') left = x - textWidth(text, font, size);
    const fontRes = font === 'bold' ? '/F2' : '/F1';
    this.ops.push(
      `BT ${rgb(opts.color ?? [0, 0, 0])} rg ${fontRes} ${num(size)} Tf ${num(left)} ${num(this.flip(y))} Td (${escapePdfString(toWinAnsi(text))}) Tj ET`,
    );
  }

  rect(x: number, y: number, w: number, h: number, opts: { fill?: Rgb; stroke?: Rgb; lineWidth?: number } = {}): void {
    const parts = ['q'];
    if (opts.fill) parts.push(`${rgb(opts.fill)} rg`);
    if (opts.stroke) parts.push(`${rgb(opts.stroke)} RG ${num(opts.lineWidth ?? 0.75)} w`);
    parts.push(`${num(x)} ${num(this.flip(y + h))} ${num(w)} ${num(h)} re`);
    parts.push(opts.fill && opts.stroke ? 'B' : opts.fill ? 'f' : 'S');
    parts.push('Q');
    this.ops.push(parts.join(' '));
  }

  line(x1: number, y1: number, x2: number, y2: number, color: Rgb = [0, 0, 0], lineWidth = 0.75): void {
    this.ops.push(
      `q ${rgb(color)} RG ${num(lineWidth)} w ${num(x1)} ${num(this.flip(y1))} m ${num(x2)} ${num(this.flip(y2))} l S Q`,
    );
  }

  image(image: JpegImage, x: number, y: number, w: number, h: number): void {
    const index = this.doc.registerImage(image);
    if (!this.images.includes(index)) this.images.push(index);
    this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.flip(y + h))} cm /Im${index} Do Q`);
  }
}

export class PdfDocument {
  readonly pages: PdfPage[] = [];
  private readonly imageList: JpegImage[] = [];
  private readonly imageIndex = new Map<JpegImage, number>();

  constructor(readonly size: PageSize = A4_PORTRAIT) {}

  addPage(): PdfPage {
    const page = new PdfPage(this);
    this.pages.push(page);
    return page;
  }

  registerImage(image: JpegImage): number {
    let index = this.imageIndex.get(image);
    if (index === undefined) {
      index = this.imageList.length;
      this.imageList.push(image);
      this.imageIndex.set(image, index);
    }
    return index;
  }

  build(): Uint8Array<ArrayBuffer> {
    const encoder = new TextEncoder(); // only ever fed ASCII below
    const chunks: Uint8Array[] = [];
    const offsets: number[] = [];
    let length = 0;
    const push = (chunk: Uint8Array | string): void => {
      const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
      chunks.push(bytes);
      length += bytes.length;
    };

    // Object numbers: 1 catalog, 2 pages, 3 F1, 4 F2, then images, then
    // (page, content) pairs.
    const imageObj = (i: number): number => 5 + i;
    const firstPageObj = 5 + this.imageList.length;
    const pageObj = (i: number): number => firstPageObj + i * 2;
    const contentObj = (i: number): number => firstPageObj + i * 2 + 1;
    const totalObjects = firstPageObj + this.pages.length * 2 - 1;

    const beginObj = (n: number): void => {
      offsets[n] = length;
      push(`${n} 0 obj\n`);
    };

    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment

    beginObj(1);
    push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    beginObj(2);
    const kids = this.pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ');
    push(`<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>\nendobj\n`);

    beginObj(3);
    push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n');
    beginObj(4);
    push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n');

    this.imageList.forEach((img, i) => {
      beginObj(imageObj(i));
      push(
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`,
      );
      push(img.bytes);
      push('\nendstream\nendobj\n');
    });

    this.pages.forEach((page, i) => {
      const xobjects = page.images.map((idx) => `/Im${idx} ${imageObj(idx)} 0 R`).join(' ');
      beginObj(pageObj(i));
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.size.width)} ${num(this.size.height)}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >> ` +
          `/Contents ${contentObj(i)} 0 R >>\nendobj\n`,
      );
      const content = encoder.encode(page.ops.join('\n'));
      beginObj(contentObj(i));
      push(`<< /Length ${content.length} >>\nstream\n`);
      push(content);
      push('\nendstream\nendobj\n');
    });

    const xrefOffset = length;
    let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= totalObjects; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    push(xref);
    push(`trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    const out = new Uint8Array(length);
    let pos = 0;
    for (const chunk of chunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    return out;
  }
}
