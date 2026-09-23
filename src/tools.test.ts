import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerTools } from "./tools.js";

describe("registerTools beforeTool", () => {
    it("refreshes state before executing every tool", async () => {
        const tools = new Map<string, { execute: (args: unknown, context: unknown) => Promise<unknown> }>();
        const server = {
            addTool(tool: { name: string; execute: (args: unknown, context: unknown) => Promise<unknown> }) {
                tools.set(tool.name, tool);
                return tool;
            },
        };
        let refreshes = 0;
        const beforeTool = async () => {
            refreshes++;
        };

        registerTools(
            server as never,
            {} as never,
            { size: 7 } as never,
            "Test Vault",
            true,
            null,
            { mode: "couchdb", readOnly: true, version: "test", changeTracking: "on-demand" },
            beforeTool,
        );

        const status = await tools.get("get_server_status")!.execute({}, {});
        assert.equal(refreshes, 1);
        assert.deepEqual(JSON.parse(status as string), {
            mode: "couchdb",
            readOnly: true,
            version: "test",
            changeTracking: "on-demand",
            indexed_notes: 7,
            write_folders: null,
            supported_text_extensions: [".md", ".base", ".canvas"],
        });
    });
});
