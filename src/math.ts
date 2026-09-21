/** Code spans we never rewrite: fenced blocks (an unclosed tail counts too —
 *  it is still streaming in) and single-backtick inline code. */
const CODE_SPAN = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

/** Spans immune to newline hardening: code plus `$`/`$$` math, which normalizeMath
 *  may have just produced. Inline `$…$` cannot cross a line, so matching currency
 *  is harmless: such a false span holds no newline either. */
const CODE_OR_MATH_SPAN = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\$\$[\s\S]+?\$\$|\$[^\n$]+\$/g;

/** Apply fn to the text between matches of re; matched spans pass through verbatim.
 *  fn also receives the last character of the preceding span ("\n" at the start),
 *  so it can tell a line continued from a span apart from a blank line. */
function mapOutsideSpans(markdown: string, re: RegExp, fn: (seg: string, prev: string) => string): string {
	re.lastIndex = 0;
	const parts: string[] = [];
	let last = 0;
	let prev = "\n";
	let m: RegExpExecArray | null;
	while ((m = re.exec(markdown)) !== null) {
		parts.push(fn(markdown.slice(last, m.index), prev), m[0]);
		prev = m[0].charAt(m[0].length - 1);
		last = m.index + m[0].length;
	}
	parts.push(fn(markdown.slice(last), prev));
	return parts.join("");
}

/** ChatGPT-style math: LLMs emit \[...\], \(...\) and ```math fences that Obsidian's
 *  markdown does not render — normalize them to $ / $$ that it does. */
export function normalizeMath(markdown: string): string {
	/* Fenced math first, while the fences are still intact */
	const fenced = markdown.replace(
		/```math\s*\n([\s\S]*?)```/g,
		(_m, body: string) => "$$\n" + body.replace(/\s+$/, "") + "\n$$"
	);
	return mapOutsideSpans(fenced, CODE_SPAN, (seg) =>
		seg
			.replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => "$$" + body + "$$")
			.replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => "$" + body + "$")
	);
}

/** Chat messages are typed text, not authored markdown: keep single line breaks
 *  visible (outside code) the way chat UIs do. */
export function hardenChatNewlines(markdown: string): string {
	return mapOutsideSpans(markdown, CODE_OR_MATH_SPAN, (seg, prev) => {
		let first = true;
		return seg.replace(/([^\n]*)\n/g, (m, line: string) => {
			/* A newline right after a span ends a real line; only after another newline
			 * (or an empty line mid-segment) is it a blank line — leave those alone. */
			const blank = !line.trim() && (first ? prev === "\n" : true);
			first = false;
			/* Two+ trailing spaces or a backslash are already hard breaks */
			if (blank || line.endsWith("  ") || line.endsWith("\\")) return m;
			return line + "  \n";
		});
	});
}
