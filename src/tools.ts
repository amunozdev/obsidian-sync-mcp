import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { basename } from "path";
import { makeDeepLink } from "./deeplink.js";
import type { VaultBackend } from "./vault-backend.js";
import type { SearchIndex } from "./search.js";
import { isPathWritable } from "./write-scope.js";
import { extractSnippet } from "./parse.js";

export interface ServerStatus {
    mode: "filesystem" | "couchdb";
    readOnly: boolean;
    version: string;
}

const debugLogging = process.env.LOG_LEVEL === "debug";

const WRITE_TOOLS = ["write_note", "edit_note", "delete_note", "move_note"] as const;

export function registerTools(
    server: FastMCP,
    vault: VaultBackend,
    searchIndex: SearchIndex,
    vaultName: string,
    readOnly = false,
    writeFolders: string[] | null = null,
    serverStatus: ServerStatus = { mode: "filesystem", readOnly, version: "unknown" },
) {
    if (readOnly) {
        console.log(`READ_ONLY mode: write tools disabled (${WRITE_TOOLS.join(", ")}).`);
    } else if (writeFolders) {
        console.log(`WRITE_FOLDERS: writes restricted to ${writeFolders.map((f) => f + "/").join(", ")}.`);
    }
    const writeScopeNote = writeFolders
        ? ` Writes are only allowed inside: ${writeFolders.map((f) => f + "/").join(", ")}.`
        : "";
    const denyWrite = (path: string) =>
        `Write access denied: '${path}' is outside the writable folders (${writeFolders!.map((f) => f + "/").join(", ")}).`;
    const textFileExtensions = [".md", ".base", ".canvas"];
    const isTextFile = (path: string) => textFileExtensions.some((extension) => path.endsWith(extension));
    const writeConflict = (reason: string | undefined, currentMtime: number | undefined) =>
        `Conflict: ${reason ?? "file changed"}.${currentMtime === undefined ? "" : ` Current mtime: ${currentMtime}.`}`;
    const rewriteLinks = (content: string, from: string, to: string) => {
        const fromPath = from.replace(/\.md$/i, "");
        const toPath = to.replace(/\.md$/i, "");
        const fromName = basename(fromPath);
        const toName = basename(toPath);
        let changes = 0;
        const rewritten = content
            .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, (full, rawTarget: string, alias = "") => {
                const headingIndex = rawTarget.search(/[#^]/);
                const target = headingIndex === -1 ? rawTarget : rawTarget.slice(0, headingIndex);
                const suffix = headingIndex === -1 ? "" : rawTarget.slice(headingIndex);
                const normalized = target.replace(/\.md$/i, "");
                if (normalized !== fromPath && normalized !== fromName) return full;
                changes++;
                const replacement = normalized === fromName ? toName : toPath;
                return `[[${replacement}${suffix}${alias}]]`;
            })
            .replace(/\]\(([^)]+\.md)\)/g, (full, target: string) => {
                if (target !== from && target.replace(/\.md$/i, "") !== fromPath) return full;
                changes++;
                return `](${to})`;
            });
        return { changes, content: rewritten };
    };
    const findRenameUpdates = async (from: string, to: string) => {
        const updates: Array<{ path: string; content: string; mtime: number; changes: number }> = [];
        for (const path of searchIndex.getBacklinks(from)) {
            const metadata = await vault.getMetadata(path);
            const content = await vault.readNote(path);
            if (!metadata || content === null) continue;
            const rewritten = rewriteLinks(content, from, to);
            if (rewritten.changes > 0) updates.push({ path, content: rewritten.content, mtime: metadata.mtime, changes: rewritten.changes });
        }
        return updates;
    };
    const _addTool = server.addTool.bind(server);
    server.addTool = (tool: any) => {
        const original = tool.execute;
        tool.execute = async (args: any, ctx: any) => {
            if (debugLogging) console.log(`[tool] ${tool.name}(${JSON.stringify(args)})`);
            const start = performance.now();
            const result = await original(args, ctx);
            if (debugLogging) console.log(`[tool] ${tool.name} → ${((performance.now() - start)).toFixed(0)}ms`);
            return result;
        };
        return _addTool(tool);
    };
    server.addTool({
        name: "read_note",
        description:
            "Read the content of a note from the Obsidian vault. Returns the markdown content and a deep link to open it in Obsidian.",
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
        }),
        execute: async ({ path }) => {
            const content = await vault.readNote(path);
            if (content === null) {
                return `Note not found: ${path}`;
            }
            const deepLink = makeDeepLink(vaultName, path);
            return `[Open in Obsidian](${deepLink})\n\n---\n\n${content}`;
        },
    });

    if (!readOnly) server.addTool({
        name: "write_note",
        description:
            "Write or update a note in the Obsidian vault. Creates the note if it doesn't exist. Replaces the entire content if it does — read first if you need to preserve existing content." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
            content: z.string().describe("Full markdown content for the note"),
            create_only: z.boolean().optional().describe("Fail if the note already exists."),
            expected_mtime: z.number().optional().describe("Only write if the current modification timestamp matches this value."),
        }),
        execute: async ({ path, content, create_only, expected_mtime }) => {
            if (!isPathWritable(path, writeFolders)) return denyWrite(path);
            const result = await vault.writeNoteConditional(path, content, {
                createOnly: create_only,
                expectedMtime: expected_mtime,
            });
            if (result.conflict) return writeConflict(result.reason, result.currentMtime);
            if (!result.ok) {
                return `Failed to write note: ${path}`;
            }
            searchIndex.update(path, content, Date.now());
            const deepLink = makeDeepLink(vaultName, path);
            return `Note saved: ${path}\n[Open in Obsidian](${deepLink})`;
        },
    });

    server.addTool({
        name: "list_notes",
        description: "List markdown notes in the vault with modification timestamps. Examples: list_notes(sort_by='modified', limit=10) for 10 most recent notes. list_notes(name='meeting') to find notes by name. list_notes(folder='daily') for a specific folder. list_notes(tag='project') for notes with a specific tag. Returns up to 100 notes by default.",
        parameters: z.object({
            folder: z
                .string()
                .optional()
                .describe("Folder to filter by, e.g. 'daily' or 'projects'. Omit for all notes."),
            name: z
                .string()
                .optional()
                .describe("Filter by name (case-insensitive substring match on path), e.g. 'meeting' or 'project-x'."),
            tag: z
                .string()
                .optional()
                .describe("Filter by tag, e.g. 'project' or 'daily'. Use list_tags to discover available tags."),
            sort_by: z
                .enum(["name", "modified"])
                .optional()
                .describe("Sort order: 'name' (default) or 'modified' (most recent first)."),
            modified_after: z
                .string()
                .optional()
                .describe("Only include notes modified after this ISO date, e.g. '2026-03-25' or '2026-03-25T10:00'."),
            offset: z.coerce
                .number()
                .int()
                .min(0)
                .optional()
                .describe("Number of matching notes to skip. Use with next_offset for pagination."),
            limit: z.coerce
                .number()
                .int()
                .min(1)
                .max(1000)
                .optional()
                .describe("Max number of notes to return. Default 100."),
            format: z
                .enum(["markdown", "json"])
                .optional()
                .describe("Response format. Default markdown; json returns pagination metadata and note objects."),
        }),
        execute: async ({ folder, name, tag, sort_by, modified_after, offset, limit, format }) => {
            // Use search index (works with encrypted vaults), fall back to vault
            let notes = searchIndex.listWithMtime(folder);
            if (notes.length === 0) {
                notes = await vault.listNotesWithMtime(folder);
            }
            if (name) {
                const lower = name.toLowerCase();
                notes = notes.filter((n) => n.path.toLowerCase().includes(lower));
            }
            if (tag) {
                notes = notes.filter((n) => searchIndex.getTags(n.path).includes(tag));
            }
            if (modified_after) {
                const cutoff = new Date(modified_after).getTime();
                if (isNaN(cutoff)) return `Invalid date format: ${modified_after}. Use ISO format like '2026-03-25'.`;
                notes = notes.filter((n) => n.mtime >= cutoff);
            }
            if (notes.length === 0) {
                return folder ? `No notes found in folder: ${folder}` : "Vault is empty.";
            }
            if (sort_by === "modified") {
                notes.sort((a, b) => b.mtime - a.mtime);
            }
            const cap = limit ?? 100;
            const start = offset ?? 0;
            const total = notes.length;
            const capped = notes.slice(start, start + cap);
            const nextOffset = start + capped.length < total ? start + capped.length : null;
            if (format === "json") {
                return JSON.stringify({
                    notes: capped.map((note) => ({
                        ...note,
                        deep_link: makeDeepLink(vaultName, note.path),
                    })),
                    total,
                    offset: start,
                    limit: cap,
                    next_offset: nextOffset,
                });
            }
            const lines = capped.map((n) => {
                const deepLink = makeDeepLink(vaultName, n.path);
                const date = n.mtime ? new Date(n.mtime).toISOString().slice(0, 16) : "";
                return `- ${date} [${n.path}](${deepLink})`;
            });
            if (nextOffset !== null) {
                lines.push(`\n... and ${total - nextOffset} more. Continue with offset=${nextOffset}.`);
            }
            return lines.join("\n");
        },
    });

    server.addTool({
        name: "list_folders",
        description:
            "List all folders in the vault. Use this to discover folder names before writing or listing notes. Returns the folder tree with note counts.",
        parameters: z.object({}),
        execute: async () => {
            let paths = searchIndex.listPaths();
            if (paths.length === 0) {
                paths = await vault.listNotes();
            }
            const folders = new Map<string, number>();
            for (const p of paths) {
                const lastSlash = p.lastIndexOf("/");
                if (lastSlash === -1) {
                    folders.set("(root)", (folders.get("(root)") ?? 0) + 1);
                } else {
                    const folder = p.slice(0, lastSlash);
                    folders.set(folder, (folders.get(folder) ?? 0) + 1);
                    // Ensure all parent folders appear in the list
                    let parent = folder;
                    while (parent.includes("/")) {
                        parent = parent.slice(0, parent.lastIndexOf("/"));
                        if (!folders.has(parent)) folders.set(parent, 0);
                    }
                }
            }
            if (folders.size === 0) {
                return "Vault is empty.";
            }
            const sorted = [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            return sorted.map(([f, count]) => `- ${f} (${count} notes)`).join("\n");
        },
    });
    server.addTool({
        name: "search_notes",
        description: "Search note contents without persisting plaintext. Scans matching markdown notes on demand with bounded results and optional folder/date filters.",
        parameters: z.object({
            query: z.string().min(2).max(500).describe("Text or words to find."),
            folder: z.string().optional().describe("Optional vault-relative folder scope."),
            modified_after: z.string().optional().describe("Optional ISO date cutoff."),
            limit: z.coerce.number().int().min(1).max(50).optional().describe("Maximum matches. Default 20."),
            context: z.coerce.number().int().min(20).max(500).optional().describe("Characters of context around each match. Default 120."),
            format: z.enum(["markdown", "json"]).optional().describe("Response format. Default markdown."),
        }),
        execute: async ({ query, folder, modified_after, limit, context, format }) => {
            let notes = searchIndex.listWithMtime(folder);
            if (notes.length === 0) notes = await vault.listNotesWithMtime(folder);
            if (modified_after) {
                const cutoff = new Date(modified_after).getTime();
                if (isNaN(cutoff)) return `Invalid date format: ${modified_after}. Use ISO format like '2026-03-25'.`;
                notes = notes.filter((note) => note.mtime >= cutoff);
            }
            const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
            const matches: Array<{ path: string; mtime: number; snippet: string; deep_link: string }> = [];
            for (const note of notes) {
                const content = await vault.readNote(note.path);
                if (content === null) continue;
                const lower = content.toLocaleLowerCase();
                if (!words.every((word) => lower.includes(word))) continue;
                matches.push({
                    path: note.path,
                    mtime: note.mtime,
                    snippet: extractSnippet(content, query, context ?? 120).replace(/\s+/g, " "),
                    deep_link: makeDeepLink(vaultName, note.path),
                });
                if (matches.length >= (limit ?? 20)) break;
            }
            if (format === "json") return JSON.stringify({ query, matches });
            if (matches.length === 0) return `No notes found for: ${query}`;
            return matches.map((match) => `- [${match.path}](${match.deep_link})\n  ${match.snippet}`).join("\n");
        },
    });
    server.addTool({
        name: "list_text_files",
        description: "List supported text files in the vault: Markdown notes, Obsidian Bases, and JSON Canvas files.",
        parameters: z.object({
            folder: z.string().optional(),
            extension: z.enum(["md", "base", "canvas"]).optional(),
            offset: z.coerce.number().int().min(0).optional(),
            limit: z.coerce.number().int().min(1).max(1000).optional(),
        }),
        execute: async ({ folder, extension, offset, limit }) => {
            let files = await vault.listTextFilesWithMtime(folder);
            if (extension) files = files.filter((file) => file.path.endsWith(`.${extension}`));
            const start = offset ?? 0;
            const cap = limit ?? 100;
            const page = files.slice(start, start + cap);
            return JSON.stringify({
                files: page.map((file) => ({ ...file, deep_link: makeDeepLink(vaultName, file.path) })),
                total: files.length,
                offset: start,
                limit: cap,
                next_offset: start + page.length < files.length ? start + page.length : null,
            });
        },
    });
    server.addTool({
        name: "read_text_file",
        description: "Read a Markdown, Obsidian Base, or JSON Canvas text file.",
        parameters: z.object({ path: z.string() }),
        execute: async ({ path }) => {
            if (!isTextFile(path)) return "Unsupported file type. Allowed extensions: .md, .base, .canvas.";
            const content = await vault.readNote(path);
            if (content === null) return `File not found: ${path}`;
            return `[Open in Obsidian](${makeDeepLink(vaultName, path)})\n\n---\n\n${content}`;
        },
    });
    if (!readOnly) server.addTool({
        name: "write_text_file",
        description: "Create or update a Markdown, Obsidian Base, or JSON Canvas text file with optional conflict protection." + writeScopeNote,
        parameters: z.object({
            path: z.string(),
            content: z.string(),
            create_only: z.boolean().optional(),
            expected_mtime: z.number().optional(),
        }),
        execute: async ({ path, content, create_only, expected_mtime }) => {
            if (!isTextFile(path)) return "Unsupported file type. Allowed extensions: .md, .base, .canvas.";
            if (!isPathWritable(path, writeFolders)) return denyWrite(path);
            if (path.endsWith(".canvas")) {
                try { JSON.parse(content); } catch { return "Invalid JSON Canvas: content is not valid JSON."; }
            }
            const result = await vault.writeNoteConditional(path, content, { createOnly: create_only, expectedMtime: expected_mtime });
            if (result.conflict) return writeConflict(result.reason, result.currentMtime);
            if (result.ok && path.endsWith(".md")) searchIndex.update(path, content, Date.now());
            return result.ok
                ? `File saved: ${path}\n[Open in Obsidian](${makeDeepLink(vaultName, path)})`
                : `Failed to write file: ${path}`;
        },
    });

    server.addTool({
        name: "list_tags",
        description:
            "List all tags used in the vault, sorted by frequency. Use this to discover tags before filtering with list_notes.",
        parameters: z.object({}),
        execute: async () => {
            const tags = searchIndex.listAllTags();
            if (tags.length === 0) {
                return "No tags found in the vault.";
            }
            return tags.map(({ tag, count }) => `- #${tag} (${count} notes)`).join("\n");
        },
    });



    if (!readOnly) server.addTool({
        name: "edit_note",
        description:
            "Edit a note without rewriting it. Use 'append' (default) to add content to the end, 'prepend' to add after frontmatter, or 'replace' to swap old_text with new content. For replace, the old_text must match exactly once." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-25.md'"),
            content: z.string().describe("Text to append, prepend, or use as replacement for old_text"),
            operation: z
                .enum(["append", "prepend", "replace"])
                .optional()
                .describe("'append' (default): add to end. 'prepend': add after frontmatter. 'replace': swap old_text with content."),
            old_text: z
                .string()
                .optional()
                .describe("Required for replace operation. Exact text to find and replace. Must match exactly once."),
            expected_mtime: z.number().optional().describe("Only edit if the current modification timestamp matches this value."),
        }),
        execute: async ({ path, content: newContent, operation, old_text, expected_mtime }) => {
            if (!isPathWritable(path, writeFolders)) return denyWrite(path);
            const before = await vault.getMetadata(path);
            if (expected_mtime !== undefined && before?.mtime !== expected_mtime) {
                return writeConflict("File changed since it was read", before?.mtime);
            }
            const existing = await vault.readNote(path);
            if (existing === null) {
                return `Note not found: ${path}`;
            }

            let updated: string;
            const op = operation ?? "append";

            if (op === "replace") {
                if (!old_text) {
                    return "old_text is required for replace operation.";
                }
                const idx = existing.indexOf(old_text);
                if (idx === -1) {
                    return "old_text not found in note.";
                }
                if (existing.indexOf(old_text, idx + 1) !== -1) {
                    return "old_text matches multiple times. Provide a longer, unique string.";
                }
                updated = existing.slice(0, idx) + newContent + existing.slice(idx + old_text.length);
            } else if (op === "prepend") {
                // Insert after frontmatter if present
                const fmMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
                if (fmMatch) {
                    const afterFm = fmMatch[0].length;
                    updated = existing.slice(0, afterFm) + newContent + "\n" + existing.slice(afterFm);
                } else {
                    updated = newContent + "\n" + existing;
                }
            } else {
                // append
                updated = existing.endsWith("\n") ? existing + newContent : existing + "\n" + newContent;
            }

            const result = await vault.writeNoteConditional(path, updated, { expectedMtime: before?.mtime });
            if (result.conflict) return writeConflict(result.reason, result.currentMtime);
            if (!result.ok) {
                return `Failed to edit note: ${path}`;
            }
            searchIndex.update(path, updated, Date.now());
            const deepLink = makeDeepLink(vaultName, path);
            return `Note edited (${op}): ${path}\n[Open in Obsidian](${deepLink})`;
        },
    });

    if (!readOnly) server.addTool({
        name: "delete_note",
        description: "Permanently delete a note from the Obsidian vault. Prefer trash_note; this operation requires explicit confirmation." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note to delete"),
            confirm: z.literal(true).describe("Must be true to confirm permanent deletion."),
        }),
        execute: async ({ path }) => {
            if (!isPathWritable(path, writeFolders)) return denyWrite(path);
            const ok = await vault.deleteNote(path);
            if (ok) searchIndex.remove(path);
            return ok ? `Deleted: ${path}` : `Failed to delete: ${path}`;
        },
    });
    if (!readOnly) server.addTool({
        name: "trash_note",
        description: "Move a note to the vault's .trash folder so it can be recovered." + writeScopeNote,
        parameters: z.object({ path: z.string() }),
        execute: async ({ path }) => {
            if (!isPathWritable(path, writeFolders)) return denyWrite(path);
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const target = `.trash/${stamp}-${basename(path)}`;
            const content = await vault.readNote(path);
            if (content === null) return `Note not found: ${path}`;
            const ok = await vault.moveNote(path, target);
            if (!ok) return `Failed to trash: ${path}`;
            searchIndex.remove(path);
            return `Moved to trash: ${path} → ${target}`;
        },
    });

    if (!readOnly) server.addTool({
        name: "move_note",
        description:
            "Move or rename a note. Use this to rename a note within the same folder, move it to a different folder, or both at once. Creates destination folders automatically." + writeScopeNote,
        parameters: z.object({
            from: z.string().describe("Current path, e.g. 'daily/old-name.md'"),
            to: z.string().describe("New path, e.g. 'projects/new-name.md'"),
            confirm: z.literal(true).describe("Must be true to confirm the move or rename."),
        }),
        execute: async ({ from, to }) => {
            // Moving out of a folder deletes there; moving in writes there — both ends must be writable.
            if (!isPathWritable(from, writeFolders)) return denyWrite(from);
            if (!isPathWritable(to, writeFolders)) return denyWrite(to);
            const content = await vault.readNote(from);
            const ok = await vault.moveNote(from, to);
            if (!ok) {
                return `Failed to move: ${from} → ${to}`;
            }
            searchIndex.remove(from);
            // content === "" is an empty-but-present note: keep it indexed at the new path.
            if (content !== null) searchIndex.update(to, content, Date.now());
            const deepLink = makeDeepLink(vaultName, to);
            return `Moved: ${from} → ${to}\n[Open in Obsidian](${deepLink})`;
        },
    });
    server.addTool({
        name: "preview_rename_note",
        description: "Preview the incoming links that would be rewritten by rename_note. Does not modify the vault.",
        parameters: z.object({ from: z.string(), to: z.string() }),
        execute: async ({ from, to }) => {
            const updates = await findRenameUpdates(from, to);
            return JSON.stringify({
                from,
                to,
                affected_notes: updates.map(({ path, changes }) => ({ path, changes })),
                total_notes: updates.length,
                total_links: updates.reduce((sum, update) => sum + update.changes, 0),
            });
        },
    });
    if (!readOnly) server.addTool({
        name: "rename_note",
        description: "Rename or move a note and optionally rewrite incoming links. Run preview_rename_note first. Requires explicit confirmation." + writeScopeNote,
        parameters: z.object({
            from: z.string(),
            to: z.string(),
            update_links: z.boolean().optional().describe("Rewrite incoming wikilinks and Markdown links. Default true."),
            expected_mtime: z.number().optional(),
            confirm: z.literal(true),
        }),
        execute: async ({ from, to, update_links, expected_mtime }) => {
            if (!isPathWritable(from, writeFolders)) return denyWrite(from);
            if (!isPathWritable(to, writeFolders)) return denyWrite(to);
            const sourceMetadata = await vault.getMetadata(from);
            if (!sourceMetadata) return `Note not found: ${from}`;
            if (expected_mtime !== undefined && sourceMetadata.mtime !== expected_mtime) {
                return writeConflict("Source changed since it was read", sourceMetadata.mtime);
            }
            const updates = update_links === false ? [] : await findRenameUpdates(from, to);
            const blocked = updates.find((update) => !isPathWritable(update.path, writeFolders));
            if (blocked) return `Rename blocked: incoming link in non-writable note '${blocked.path}'. Run preview_rename_note and widen the server-side write scope deliberately.`;
            const moved = await vault.moveNote(from, to);
            if (!moved) return `Failed to move: ${from} → ${to}`;
            searchIndex.remove(from);
            const movedContent = await vault.readNote(to);
            if (movedContent !== null) searchIndex.update(to, movedContent, Date.now());
            for (const update of updates) {
                const result = await vault.writeNoteConditional(update.path, update.content, { expectedMtime: update.mtime });
                if (!result.ok) return `Moved note, but stopped rewriting links at '${update.path}' because it changed concurrently.`;
                searchIndex.update(update.path, update.content, Date.now());
            }
            return `Renamed: ${from} → ${to}. Updated ${updates.reduce((sum, update) => sum + update.changes, 0)} incoming links.\n[Open in Obsidian](${makeDeepLink(vaultName, to)})`;
        },
    });

    server.addTool({
        name: "get_note_metadata",
        description:
            "Get metadata about a note without reading its full content. Returns frontmatter, tags, outgoing links, backlinks (notes that link to this one), size, and timestamps. Use this to navigate the knowledge graph.",
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'projects/my-project.md'"),
        }),
        execute: async ({ path }) => {
            const meta = await vault.getMetadata(path);
            if (!meta) {
                return `Note not found: ${path}`;
            }
            const deepLink = makeDeepLink(vaultName, path);
            const lines = [
                `**${path}**`,
                `Size: ${meta.size} bytes`,
                `Created: ${new Date(meta.ctime).toISOString()}`,
                `Modified: ${new Date(meta.mtime).toISOString()}`,
                `Modified mtime: ${meta.mtime}`,
            ];
            if (Object.keys(meta.frontmatter).length > 0) {
                lines.push(`\nFrontmatter:`);
                for (const [k, v] of Object.entries(meta.frontmatter)) {
                    lines.push(`  ${k}: ${v}`);
                }
            }
            if (meta.tags.length > 0) {
                lines.push(`\nTags: ${meta.tags.map((t) => `#${t}`).join(", ")}`);
            }
            if (meta.links.length > 0) {
                lines.push(`\nOutgoing links: ${meta.links.join(", ")}`);
            }
            const backlinks = searchIndex.getBacklinks(path);
            if (backlinks.length > 0) {
                lines.push(`\nBacklinks: ${backlinks.join(", ")}`);
            }
            lines.push(`\n[Open in Obsidian](${deepLink})`);
            return lines.join("\n");
        },
    });
    server.addTool({
        name: "get_server_status",
        description: "Report the MCP version, backend mode, index state, and effective write restrictions without exposing secrets.",
        parameters: z.object({}),
        execute: async () => JSON.stringify({
            ...serverStatus,
            indexed_notes: searchIndex.size,
            write_folders: writeFolders,
            supported_text_extensions: textFileExtensions,
        }),
    });
}
