import type { Page } from "@playwright/test";

/**
 * The faces a page draws its text with, asked of Chromium itself: CDP's
 * CSS.getPlatformFontsForNode on every element with text of its own names the face (its
 * PostScript name) that drew those glyphs, fallbacks included. A symbol no face in the stack has
 * lands on whatever macOS falls back to, and that is named too.
 *
 * This is how the renderer canary is held to the app's pages (canary.test.ts): the canary must
 * draw with every face they draw with, or an update to one it lacks moves baselines while the
 * canary reads "match".
 *
 * Each face is named with what changes how its glyphs are drawn besides the face itself:
 * " oblique" when the text is italic in a face with no italic, so Chromium slants it itself, and
 * " in SVG" for SVG <text>, which is laid out and painted by another path than HTML text.
 */

/** The part of CDP's DOM.Node this walks. */
interface DomNode {
  nodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
}

const ELEMENT = 1;
const TEXT = 3;

interface TextElement {
  nodeId: number;
  svg: boolean;
}

function textElements(node: DomNode, inSvg: boolean): TextElement[] {
  const svg = inSvg || node.nodeName.toLowerCase() === "svg";
  const children = node.children ?? [];
  const ownText = children.some((c) => c.nodeType === TEXT && c.nodeValue.trim() !== "");
  const here = node.nodeType === ELEMENT && ownText ? [{ nodeId: node.nodeId, svg }] : [];
  const below = [...children, ...(node.shadowRoots ?? [])];
  if (node.contentDocument !== undefined) below.push(node.contentDocument);
  return [...here, ...below.flatMap((child) => textElements(child, svg))];
}

/** "Geist-Regular oblique in SVG": the face, and whether it was slanted or drawn as SVG text. */
export function faceName(postScriptName: string, fontStyle: string, svg: boolean): string {
  const slanted = fontStyle !== "normal" && !/italic|oblique/i.test(postScriptName);
  return `${postScriptName}${slanted ? " oblique" : ""}${svg ? " in SVG" : ""}`;
}

/** Every face the page draws text with, named by faceName, sorted. */
export async function facesDrawn(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const faces = new Set<string>();
    for (const { nodeId, svg } of textElements(root, false)) {
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      const { computedStyle } = await cdp.send("CSS.getComputedStyleForNode", { nodeId });
      const style = computedStyle.find((p) => p.name === "font-style")?.value ?? "normal";
      for (const font of fonts) faces.add(faceName(font.postScriptName, style, svg));
    }
    return [...faces].sort();
  } finally {
    await cdp.detach();
  }
}
