import type { FileFormat } from "@/db/schema/imports";
import type { SniffedFile } from "./types";

/** Content-first format detection; extensions are a hint, never trusted alone. */
export function sniffFile(name: string, buffer: Buffer): SniffedFile {
  const head = buffer.subarray(0, 512).toString("latin1");
  let format: FileFormat;
  if (head.startsWith("%PDF")) {
    format = "pdf";
  } else if (/OFXHEADER|<OFX>|<\?OFX/i.test(head)) {
    format = name.toLowerCase().endsWith(".qfx") ? "qfx" : "ofx";
  } else {
    format = "csv";
  }
  const text = format === "pdf" ? "" : buffer.toString("utf8");
  return { name, buffer, format, text };
}
