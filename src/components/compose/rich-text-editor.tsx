"use client";

import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import {
	Bold,
	Italic,
	Link2,
	List,
	ListOrdered,
	ArrowLeft,
	ArrowRight,
	Quote,
	RemoveFormatting,
	Strikethrough,
	Underline,
} from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { EmailHtmlRenderer } from "@/components/messages/email-html-renderer";
import { sanitizeEmailHtml, sanitizeEditorHtml } from "@/lib/email/html";
import type { RichTextEditorProps, TextDirection, ToolbarCommand } from "./rich-text-editor-types";

import { DIRECTION_BLOCK_SELECTOR, SIGNATURE_ATTRIBUTE, listDirection } from "./rich-text-utils";

const COMMANDS: ToolbarCommand[] = [
	{ command: "bold", labelKey: "editor.bold", icon: Bold },
	{ command: "italic", labelKey: "editor.italic", icon: Italic },
	{ command: "underline", labelKey: "editor.underline", icon: Underline },
	{ command: "strikeThrough", labelKey: "editor.strikethrough", icon: Strikethrough },
	{ command: "insertUnorderedList", labelKey: "editor.bulletedList", icon: List },
	{ command: "insertOrderedList", labelKey: "editor.numberedList", icon: ListOrdered },
	{ command: "formatBlock", labelKey: "editor.quote", icon: Quote, value: "blockquote" },
];

const DIRECTIONS: { direction: TextDirection; labelKey: ToolbarCommand["labelKey"]; icon: ToolbarCommand["icon"] }[] = [
	{ direction: "ltr", labelKey: "editor.leftToRight", icon: ArrowRight },
	{ direction: "rtl", labelKey: "editor.rightToLeft", icon: ArrowLeft },
];

function closestBlock(node: Node | null, root: HTMLElement): HTMLElement | null {
	let current = node && node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node?.parentElement ?? null;
	while (current && current !== root && root.contains(current)) {
		if (current.matches(DIRECTION_BLOCK_SELECTOR)) return current;
		current = current.parentElement;
	}
	return null;
}

/** The innermost blocks the selection touches, or null while it sits in loose text that has no block yet. */
function selectedBlocks(root: HTMLElement): HTMLElement[] | null {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return [];
	const range = selection.getRangeAt(0);
	if (!root.contains(range.commonAncestorContainer)) return [];
	const start = closestBlock(range.startContainer, root);
	const end = closestBlock(range.endContainer, root);
	if (!start || !end) return null;
	const blocks = new Set([start, end]);
	for (const block of Array.from(root.querySelectorAll<HTMLElement>(DIRECTION_BLOCK_SELECTOR))) {
		if (range.intersectsNode(block) && !block.querySelector(DIRECTION_BLOCK_SELECTOR)) blocks.add(block);
	}
	return Array.from(blocks);
}

/**
 * Paragraphs without a chosen direction follow their own first strong
 * character, and lists follow their first item so the indent sits on the
 * bullets' side. The signature keeps its markup untouched so it can be swapped.
 */
function markAutoDirection(root: HTMLElement): void {
	for (const block of Array.from(root.querySelectorAll<HTMLElement>(DIRECTION_BLOCK_SELECTOR))) {
		if (block.closest(`[${SIGNATURE_ATTRIBUTE}]`)) continue;
		if (block.tagName === "UL" || block.tagName === "OL") {
			block.setAttribute("dir", listDirection(block) === "rtl" ? "rtl" : "auto");
			continue;
		}
		if (block.hasAttribute("dir")) continue;
		const chosen = block.parentElement?.closest("[dir]:not(ul, ol)");
		if (chosen && chosen !== root && root.contains(chosen) && chosen.getAttribute("dir") !== "auto") continue;
		block.setAttribute("dir", "auto");
	}
}

function chosenDirection(root: HTMLElement): TextDirection | null {
	const block = closestBlock(window.getSelection()?.anchorNode ?? null, root);
	const value = block?.closest("[dir]");
	if (!value || !root.contains(value)) return null;
	const direction = value.getAttribute("dir");
	return direction === "rtl" || direction === "ltr" ? direction : null;
}

/**
 * A small HTML editor built on contentEditable. It stays deliberately light:
 * inline styles, lists, quotes and links, with pasted content flattened to
 * text so a message never carries another site's markup.
 */
export function RichTextEditor({
	id,
	value,
	onChange,
	quotedHtml,
	disabled,
	placeholder,
	className,
	editableClassName,
	toolbarVisible = true,
	toolbarClassName,
	toolbarStart,
	toolbarEnd,
	footerContent,
}: RichTextEditorProps) {
	const { t } = useLanguage();
	const editorRef = useRef<HTMLDivElement | null>(null);
	const [active, setActive] = useState<Record<string, boolean>>({});
	const [direction, setDirection] = useState<TextDirection | null>(null);
	const [linkOpen, setLinkOpen] = useState(false);
	const [linkUrl, setLinkUrl] = useState("");
	const [showQuoted, setShowQuoted] = useState(false);
	const savedRange = useRef<Range | null>(null);
	const lastEmitted = useRef<string | null>(null);

	// Keep the DOM in step with the value without resetting the caret on every keystroke.
	useEffect(() => {
		const element = editorRef.current;
		if (!element) return;
		if (lastEmitted.current !== null && value === lastEmitted.current) return;
		const safeValue = sanitizeEditorHtml(value);
		if (element.innerHTML !== safeValue) element.innerHTML = safeValue;
		markAutoDirection(element);
		lastEmitted.current = null;
	}, [value]);

	useEffect(() => {
		function refresh() {
			const element = editorRef.current;
			if (!element || !element.contains(document.activeElement)) return;
			const next: Record<string, boolean> = {};
			for (const item of COMMANDS) {
				if (item.command === "formatBlock") {
					next[item.command] = document.queryCommandValue("formatBlock").toLowerCase() === "blockquote";
				} else {
					next[item.command] = document.queryCommandState(item.command);
				}
			}
			setActive(next);
			setDirection(chosenDirection(element));
		}
		document.addEventListener("selectionchange", refresh);
		return () => document.removeEventListener("selectionchange", refresh);
	}, []);

	function emit() {
		// Export validated original resource addresses, never the blocked preview placeholders.
		const element = editorRef.current;
		if (element) markAutoDirection(element);
		const output = sanitizeEmailHtml(element?.innerHTML ?? "", { forOutgoing: true }) ?? "";
		lastEmitted.current = output;
		onChange(output);
	}

	function run(command: string, commandValue?: string) {
		editorRef.current?.focus();
		if (command === "formatBlock" && active.formatBlock) {
			document.execCommand("formatBlock", false, "div");
		} else {
			document.execCommand(command, false, commandValue);
		}
		emit();
	}

	/**
	 * Paragraphs follow their own first strong character until the writer picks
	 * a direction here; picking the current one again returns them to automatic.
	 */
	function applyDirection(next: TextDirection) {
		const element = editorRef.current;
		if (!element) return;
		element.focus();
		let blocks = selectedBlocks(element);
		if (blocks === null) {
			document.execCommand("formatBlock", false, "div");
			blocks = selectedBlocks(element);
		}
		if (!blocks?.length) return;
		const reset = blocks.every((block) => block.getAttribute("dir") === next);
		for (const block of blocks) block.setAttribute("dir", reset ? "auto" : next);
		setDirection(chosenDirection(element));
		emit();
	}

	function openLink() {
		const selection = window.getSelection();
		savedRange.current = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
		setLinkUrl("");
		setLinkOpen(true);
	}

	function applyLink() {
		const url = linkUrl.trim();
		setLinkOpen(false);
		if (!url) return;
		const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
		editorRef.current?.focus();
		const selection = window.getSelection();
		if (savedRange.current && selection) {
			selection.removeAllRanges();
			selection.addRange(savedRange.current);
		}
		if (selection && selection.isCollapsed) {
			// The URL field is untrusted text: build the anchor with DOM APIs so it is never parsed as HTML.
			const anchor = document.createElement("a");
			anchor.setAttribute("href", href);
			anchor.textContent = href;
			document.execCommand("insertHTML", false, anchor.outerHTML);
		} else {
			document.execCommand("createLink", false, href);
		}
		emit();
	}

	function onPaste(event: ClipboardEvent<HTMLDivElement>) {
		event.preventDefault();
		const text = event.clipboardData.getData("text/plain");
		document.execCommand("insertText", false, text);
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
			event.preventDefault();
			openLink();
		}
	}

	const formatButtons = (
		<>
		{COMMANDS.map((item) => (
			<Tooltip key={item.command} label={t(item.labelKey)}>
				<button
					type="button"
					aria-label={t(item.labelKey)}
					aria-pressed={!!active[item.command]}
					disabled={disabled}
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => run(item.command, item.value)}
					className={cn(
						"rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900",
						active[item.command] && "bg-neutral-200 text-neutral-900",
					)}
				>
					<item.icon className="h-4 w-4" />
				</button>
			</Tooltip>
		))}
		{DIRECTIONS.map((item) => (
			<Tooltip key={item.direction} label={t(item.labelKey)}>
				<button
					type="button"
					aria-label={t(item.labelKey)}
					aria-pressed={direction === item.direction}
					disabled={disabled}
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => applyDirection(item.direction)}
					className={cn(
						"rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900",
						direction === item.direction && "bg-neutral-200 text-neutral-900",
					)}
				>
					<item.icon className="h-4 w-4" />
				</button>
			</Tooltip>
		))}
		<Tooltip label={t("editor.insertLinkHint")}>
			<button
				type="button"
				aria-label={t("editor.insertLink")}
				disabled={disabled}
				onMouseDown={(event) => event.preventDefault()}
				onClick={openLink}
				className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
			>
				<Link2 className="h-4 w-4" />
			</button>
		</Tooltip>
		<Tooltip label={t("editor.clearFormatting")}>
			<button
				type="button"
				aria-label={t("editor.clearFormatting")}
				disabled={disabled}
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => run("removeFormat")}
				className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
			>
				<RemoveFormatting className="h-4 w-4" />
			</button>
		</Tooltip>
		</>
	);

	return (
		<div className={cn("flex min-h-0 flex-1 flex-col", className)}>
			<div className={cn("sticky top-0 z-10 flex shrink-0 items-center gap-0.5 overflow-x-auto bg-white px-2 py-1 md:hidden", !toolbarVisible && "hidden")}>{formatButtons}</div>
			<div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
				<div
					ref={editorRef}
					id={id}
					dir="auto"
					role="textbox"
					aria-multiline="true"
					aria-label={t("editor.messageBody")}
					contentEditable={!disabled}
					suppressContentEditableWarning
					data-placeholder={placeholder}
					onInput={emit}
					onBlur={emit}
					onPaste={onPaste}
					onKeyDown={onKeyDown}
					className={cn(
						"email-body max-w-none px-4 py-3 text-sm text-neutral-900 outline-none",
						"min-h-32 grow shrink-0 empty:before:pointer-events-none empty:before:text-neutral-400 empty:before:content-[attr(data-placeholder)]",
						disabled && "cursor-not-allowed opacity-60",
						editableClassName,
					)}
				/>
				{quotedHtml && (
					<div className="shrink-0 px-4 pb-3">
						<button
							type="button"
							onClick={() => setShowQuoted((open) => !open)}
							aria-expanded={showQuoted}
							aria-label={showQuoted ? t("editor.hideQuoted") : t("editor.showQuoted")}
							className="rounded-full border border-neutral-200 bg-neutral-100 px-2 text-xs leading-5 text-neutral-500 hover:bg-neutral-200"
							title={showQuoted ? t("editor.hideQuoted") : t("editor.showQuoted")}
						>
							•••
						</button>
						{showQuoted && (
							<EmailHtmlRenderer className="mt-2" html={quotedHtml} preserveLeadingQuote />
						)}
					</div>
				)}
			</div>
			{footerContent}
			<div
				inert={!toolbarVisible}
				className="relative grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
				style={{ gridTemplateRows: toolbarVisible ? "1fr" : "0fr" }}
			>
				<div className="min-h-0 overflow-hidden">
					<div className={cn("relative flex items-center gap-0.5 max-md:gap-2 border-t border-neutral-100 px-4 py-3 max-md:border-t-0", toolbarClassName)}>
						{toolbarStart}
						<div className="contents max-md:hidden">{formatButtons}</div>
						{toolbarEnd}
					</div>
				</div>
				{linkOpen && toolbarVisible && (
					<div
						className="absolute bottom-full left-2 z-10 mb-1 flex items-center gap-2 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg"
					>
						<input
							autoFocus
							value={linkUrl}
							onChange={(event) => setLinkUrl(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									applyLink();
								}
								if (event.key === "Escape") setLinkOpen(false);
							}}
							placeholder="https://example.com"
							aria-label={t("editor.insertLink")}
							className="h-8 w-64 rounded-md border border-neutral-200 px-2 text-sm outline-none focus:border-blue-400"
						/>
						<button type="button" onClick={applyLink} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
							{t("editor.apply")}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
