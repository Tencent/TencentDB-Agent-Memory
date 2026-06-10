/// <reference types="node" />

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

const configSource = readFileSync(fileURLToPath(new URL("./config.ts", import.meta.url)), "utf8");

function getInterfaceBlock(interfaceName: string): string {
  const match = configSource.match(new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`Interface ${interfaceName} not found`);
  return match[1];
}

function getCommentDefault(interfaceName: string, propertyName: string): string {
  const interfaceBlock = getInterfaceBlock(interfaceName);
  const lines = interfaceBlock.split("\n");
  const propertyLineIndex = lines.findIndex((line) => new RegExp(`^\\s*${propertyName}:`).test(line));
  if (propertyLineIndex === -1) throw new Error(`Property ${interfaceName}.${propertyName} not found`);

  const commentLines: string[] = [];
  for (let i = propertyLineIndex - 1; i >= 0; i--) {
    commentLines.unshift(lines[i]);
    if (lines[i].includes("/**")) break;
  }

  const defaultMatch = commentLines.join("\n").match(/default:\s*([^)]+)/);
  if (!defaultMatch) throw new Error(`Default value for ${interfaceName}.${propertyName} not found`);
  return defaultMatch[1].trim();
}

describe("config defaults", () => {
  it("keeps documented defaults in sync with zero-config parsing", () => {
    const cfg = parseConfig({});
    const defaults = [
      {
        interfaceName: "PersonaConfig",
        propertyName: "maxScenes",
        actualDefault: String(cfg.persona.maxScenes),
      },
      {
        interfaceName: "PipelineTriggerConfig",
        propertyName: "l2DelayAfterL1Seconds",
        actualDefault: String(cfg.pipeline.l2DelayAfterL1Seconds),
      },
      {
        interfaceName: "ReportConfig",
        propertyName: "enabled",
        actualDefault: String(cfg.report.enabled),
      },
    ];

    for (const { interfaceName, propertyName, actualDefault } of defaults) {
      expect(getCommentDefault(interfaceName, propertyName)).toBe(actualDefault);
    }
  });
});
