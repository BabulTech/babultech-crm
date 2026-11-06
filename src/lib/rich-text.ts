
/**
 * Sanitising rich text before it is stored or shown.
 *
 * Task descriptions are the first field in this system that holds HTML rather
 * than plain text, and the point of the feature is that people paste into it —
 * from Word, from Outlook, from a web page. Pasted markup carries whatever the
 * source had in it, so every string that arrives here is treated as hostile
 * regardless of who typed it: a colleague pasting from a compromised page is
 * the same attack as a colleague writing the script themselves.
 *
 * Sanitising happens on the **server, on write**, not only in the editor. The
 * editor runs in the browser, so its output is whatever the browser chose to
 * send — a crafted request can post anything at all. Cleaning on the way in
 * also means the database never holds a payload that some future screen might
 * render without thinking.
 *
 * The allowlist is deliberately small: the formatting a description actually
 * needs, and nothing that can execute, load, or position anything. Nothing here
 * permits `script`, `style`, `iframe`, `object`, `embed`, `form`, event handler
 * attributes, or inline styles.
 */

/** Tags a description may contain. Formatting only — nothing that executes. */
const ALLOWED_TAGS = [
  "p", "br", "strong", "b", "em", "i", "u", "s", "strike", "del",
  "ul", "ol", "li",
  "h1", "h2", "h3", "h4",
  "blockquote", "code", "pre",
  "a", "span", "hr",
];

/**
 * Attributes that survive.
 *
 * `href` on a link only; `target`/`rel` are added by the hook below rather than
 * accepted from input, so a pasted link cannot opt itself out of the protection.
 * No `style`, no `class`, no `id`, no `on*`.
 */
const ALLOWED_ATTR = ["href", "title"];

/**
 * Link schemes that are safe to follow.
 *
 * `javascript:` is the obvious one to exclude, but `data:` matters just as
 * much — a `data:text/html` link opens attacker-controlled markup in the site's
 * own context.
 */
const SAFE_SCHEMES = /^(https?:|mailto:|tel:)/i;

/**
 * The cleaner is sanitize-html, which parses with htmlparser2 and needs no DOM.
 *
 * It replaced isomorphic-dompurify on 11 October 2026. That pulled in jsdom,
 * whose html-encoding-sniffer `require()`s an ESM-only package; Vercel's Node
 * runtime refuses that with ERR_REQUIRE_ESM, so every save that cleaned a
 * description (a product, a project, a portal case) crashed in production while
 * working on a developer's newer Node. Loading it lazily had only moved the
 * crash from page load to save.
 */
import sanitizeHtml from "sanitize-html";

const CLEAN_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  // target and rel are written by the link transform below, never taken from
  // input: the transform drops whatever a pasted link brought with it.
  allowedAttributes: { "*": ALLOWED_ATTR.filter((a) => a !== "href"), a: [...ALLOWED_ATTR, "target", "rel"] },
  // Keep the text of a disallowed element rather than discarding it: someone
  // pasting from a page wrapped in a <div> should not lose their words. The
  // text inside script, style and the like is still dropped.
  disallowedTagsMode: "discard",
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  /**
   * Every surviving link opens in a new tab with `rel="noopener noreferrer"`,
   * and a link whose scheme is not on the safe list loses its href rather than
   * the whole element being dropped: the text a person wrote is still worth
   * keeping even when the destination is not.
   */
  transformTags: {
    // Chrome's editor starts each new line as a <div>. Kept as a line, not
    // dropped: dropping it ran "Hi Ali," and the next line together.
    div: "p",
    a: (tagName, attribs) => {
      const href = attribs.href ?? "";
      const kept: Record<string, string> = attribs.title ? { title: attribs.title } : {};
      if (!SAFE_SCHEMES.test(href)) return { tagName, attribs: kept };
      return { tagName, attribs: { ...kept, href, target: "_blank", rel: "noopener noreferrer nofollow" } };
    },
  },
};

/**
 * Clean a rich-text value for storage.
 *
 * Returns null for anything that carries no text once the markup is stripped,
 * so an "empty" editor — which posts `<p></p>` or `<p><br></p>` rather than an
 * empty string — is stored as a genuinely empty field. Without this, every
 * description that was opened and left alone would read as non-empty forever.
 */
export function sanitizeRichText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.trim() === "") return null;

  const clean = sanitizeHtml(value, CLEAN_OPTIONS);

  return richTextToPlain(clean).trim() === "" ? null : clean;
}

/**
 * The readable text inside a rich-text value, for places that cannot render
 * HTML: a list cell, a search index, a notification email's preview line.
 *
 * Block tags become spaces rather than vanishing, so "one</p><p>two" reads as
 * "one two" instead of "onetwo".
 */
export function richTextToPlain(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The text of a rich-text value with its lines kept: one line per line the
 * writer typed, a blank line where they left one. For an email's plain-text
 * part, which must read the way the email was written.
 */
export function richTextToLines(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    // A line starts where a block opens: "Hi,<p>Thanks</p>" is two lines, and
    // an empty block is a blank one.
    .replace(/<(p|div|h[1-6]|blockquote|pre|tr)(\s[^>]*)?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Whether a stored value is HTML rather than the plain text written before this
 * feature existed.
 *
 * Existing descriptions are plain strings with real newlines. They must keep
 * rendering as they were written, so the reader decides which way to display a
 * value rather than assuming everything in the column is markup.
 */
export function looksLikeHtml(value: string | null | undefined): boolean {
  if (!value) return false;
  return /<\/?(p|br|ul|ol|li|strong|em|b|i|u|h[1-4]|blockquote|code|pre|a|span|hr|s|del|strike)\b[^>]*>/i.test(
    value,
  );
}
