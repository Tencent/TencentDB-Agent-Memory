/**
 * Read-only Markdown file access for L2 scene blocks and L3 persona.
 *
 * This module owns the mapping between public file_id values and the actual
 * memory-data files. Callers never pass or receive real filesystem paths.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseSceneBlock } from "../core/scene/scene-format.js";
import { readSceneIndex } from "../core/scene/scene-index.js";
import type {
  ListMarkdownFilesPayload,
  MarkdownFileDetail,
  MarkdownFileInfo,
  MarkdownView,
  UpdateMarkdownFileRequest,
} from "./types.js";

const PROFILE_FILE_ID = "profile_persona";
const SCENE_FILE_ID_PREFIX = "scene_";
const SCENE_NAV_HEADER = "---\n## 🗺️ Scene Navigation (Scene Index)";

export class MarkdownFilesError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MarkdownFilesError";
  }
}

export async function listMarkdownFiles(
  dataDir: string,
  view: MarkdownView,
): Promise<ListMarkdownFilesPayload> {
  if (view === "domain") {
    return { files: await listSceneFiles(dataDir) };
  }

  if (view === "profile") {
    return { files: await listProfileFiles(dataDir) };
  }

  throw invalidView();
}

export async function getMarkdownFile(
  dataDir: string,
  fileId: string,
): Promise<MarkdownFileDetail> {
  if (fileId === PROFILE_FILE_ID) {
    return readProfileFile(dataDir);
  }

  if (fileId.startsWith(SCENE_FILE_ID_PREFIX)) {
    return readSceneFile(dataDir, fileId);
  }

  throw notFound(fileId);
}

export async function updateMarkdownFile(
  dataDir: string,
  fileId: string,
  request: UpdateMarkdownFileRequest,
): Promise<MarkdownFileDetail> {
  if (fileId === PROFILE_FILE_ID) {
    return updateProfileFile(dataDir, request);
  }

  if (fileId.startsWith(SCENE_FILE_ID_PREFIX)) {
    throw readonly(fileId);
  }

  throw notFound(fileId);
}

function sceneFileId(filename: string): string {
  return `${SCENE_FILE_ID_PREFIX}${base64UrlEncode(filename)}`;
}

function sceneFilenameFromId(fileId: string): string {
  const encoded = fileId.slice(SCENE_FILE_ID_PREFIX.length);
  if (!encoded) throw notFound(fileId);

  let filename: string;
  try {
    filename = base64UrlDecode(encoded);
  } catch {
    throw notFound(fileId);
  }

  if (!isSafeSceneFilename(filename)) {
    throw notFound(fileId);
  }
  return filename;
}

async function listSceneFiles(dataDir: string): Promise<MarkdownFileInfo[]> {
  const entries = await readSceneEntries(dataDir);
  const files: MarkdownFileInfo[] = [];

  for (const entry of entries) {
    if (!isSafeSceneFilename(entry.filename)) continue;

    const filePath = safeScenePath(dataDir, entry.filename);
    let raw = "";
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const block = parseSceneBlock(raw, entry.filename);
    const updatedAt = block.meta.updated || entry.updated || await fileMtimeIso(filePath);
    files.push({
      file_id: sceneFileId(entry.filename),
      view: "domain",
      title: titleFromFilename(entry.filename),
      summary: block.meta.summary || entry.summary || "",
      heat: block.meta.heat || entry.heat || 0,
      updated_at: updatedAt,
      version: contentVersion(raw),
    });
  }

  return files.sort((a, b) => {
    const heatDiff = (b.heat ?? 0) - (a.heat ?? 0);
    if (heatDiff !== 0) return heatDiff;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  });
}

async function listProfileFiles(dataDir: string): Promise<MarkdownFileInfo[]> {
  const personaPath = path.join(dataDir, "persona.md");
  let raw: string;
  try {
    raw = await fs.readFile(personaPath, "utf-8");
  } catch {
    return [];
  }

  return [{
    file_id: PROFILE_FILE_ID,
    view: "profile",
    title: "用户画像",
    updated_at: await fileMtimeIso(personaPath),
    version: contentVersion(raw),
  }];
}

async function readSceneFile(dataDir: string, fileId: string): Promise<MarkdownFileDetail> {
  const filename = sceneFilenameFromId(fileId);
  const filePath = safeScenePath(dataDir, filename);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    throw notFound(fileId);
  }

  const block = parseSceneBlock(raw, filename);
  return {
    file_id: fileId,
    view: "domain",
    title: titleFromFilename(filename),
    summary: block.meta.summary,
    heat: block.meta.heat,
    created_at: block.meta.created || undefined,
    updated_at: block.meta.updated || await fileMtimeIso(filePath),
    content: block.content,
    version: contentVersion(raw),
  };
}

async function readProfileFile(dataDir: string): Promise<MarkdownFileDetail> {
  const personaPath = path.join(dataDir, "persona.md");

  let raw: string;
  try {
    raw = await fs.readFile(personaPath, "utf-8");
  } catch {
    throw notFound(PROFILE_FILE_ID);
  }

  const { content, sceneNavigation } = splitSceneNavigation(raw);
  return {
    file_id: PROFILE_FILE_ID,
    view: "profile",
    title: "用户画像",
    updated_at: await fileMtimeIso(personaPath),
    content,
    scene_navigation: sceneNavigation,
    version: contentVersion(raw),
  };
}

async function updateProfileFile(
  dataDir: string,
  request: UpdateMarkdownFileRequest,
): Promise<MarkdownFileDetail> {
  const personaPath = path.join(dataDir, "persona.md");

  let raw: string;
  try {
    raw = await fs.readFile(personaPath, "utf-8");
  } catch {
    throw notFound(PROFILE_FILE_ID);
  }

  const currentVersion = contentVersion(raw);
  if (request.expected_version !== currentVersion) {
    throw versionConflict(currentVersion);
  }

  if (request.content.includes(SCENE_NAV_HEADER)) {
    throw invalidContent("Scene navigation is generated by the memory pipeline and cannot be edited here");
  }

  const { sceneNavigation } = splitSceneNavigation(raw);
  const nextRaw = composeProfileFile(request.content, sceneNavigation);
  await fs.writeFile(personaPath, nextRaw, "utf-8");

  return readProfileFile(dataDir);
}

async function readSceneEntries(dataDir: string): Promise<Array<{
  filename: string;
  summary: string;
  heat: number;
  updated: string;
}>> {
  const indexed = await readSceneIndex(dataDir);
  if (indexed.length > 0) return indexed;

  const blocksDir = path.join(dataDir, "scene_blocks");
  let filenames: string[];
  try {
    filenames = (await fs.readdir(blocksDir)).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }

  const entries = [];
  for (const filename of filenames) {
    if (!isSafeSceneFilename(filename)) continue;
    try {
      const filePath = path.join(blocksDir, filename);
      const raw = await fs.readFile(filePath, "utf-8");
      const block = parseSceneBlock(raw, filename);
      entries.push({
        filename,
        summary: block.meta.summary,
        heat: block.meta.heat,
        updated: block.meta.updated || await fileMtimeIso(filePath),
      });
    } catch {
      continue;
    }
  }
  return entries;
}

function splitSceneNavigation(raw: string): { content: string; sceneNavigation?: string } {
  const idx = raw.indexOf(SCENE_NAV_HEADER);
  if (idx === -1) {
    return { content: raw.trim() };
  }

  const prefix = raw.slice(0, idx).trimEnd();
  const navigation = raw.slice(idx).trim();
  return {
    content: prefix,
    sceneNavigation: navigation || undefined,
  };
}

function composeProfileFile(content: string, sceneNavigation?: string): string {
  const normalizedContent = content.replace(/\r\n/g, "\n").trim();
  if (!sceneNavigation) {
    return `${normalizedContent}\n`;
  }

  return `${normalizedContent}\n\n${sceneNavigation.trim()}\n`;
}

function safeScenePath(dataDir: string, filename: string): string {
  if (!isSafeSceneFilename(filename)) {
    throw notFound(filename);
  }

  const blocksDir = path.resolve(dataDir, "scene_blocks");
  const filePath = path.resolve(blocksDir, filename);
  if (!filePath.startsWith(`${blocksDir}${path.sep}`)) {
    throw notFound(filename);
  }
  return filePath;
}

function isSafeSceneFilename(filename: string): boolean {
  return (
    filename.endsWith(".md") &&
    filename.length > ".md".length &&
    !filename.includes("/") &&
    !filename.includes("\\") &&
    path.basename(filename) === filename
  );
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.md$/i, "");
}

async function fileMtimeIso(filePath: string): Promise<string> {
  try {
    return (await fs.stat(filePath)).mtime.toISOString();
  } catch {
    return "";
  }
}

function contentVersion(content: string): string {
  const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  return `sha256:${hash}`;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, "=");
  return Buffer.from(padded, "base64").toString("utf-8");
}

function invalidView(): MarkdownFilesError {
  return new MarkdownFilesError(
    "MEMORY_MARKDOWN_INVALID_VIEW",
    "Invalid markdown view. Expected domain or profile",
    400,
  );
}

function notFound(fileId: string): MarkdownFilesError {
  return new MarkdownFilesError(
    "MEMORY_MARKDOWN_NOT_FOUND",
    `Markdown file not found: ${fileId}`,
    404,
  );
}

function readonly(fileId: string): MarkdownFilesError {
  return new MarkdownFilesError(
    "MEMORY_MARKDOWN_READONLY",
    `Markdown file is read-only in this version: ${fileId}`,
    405,
  );
}

function invalidContent(message: string): MarkdownFilesError {
  return new MarkdownFilesError(
    "MEMORY_MARKDOWN_INVALID_CONTENT",
    message,
    400,
  );
}

function versionConflict(currentVersion: string): MarkdownFilesError {
  return new MarkdownFilesError(
    "MEMORY_MARKDOWN_VERSION_CONFLICT",
    `Markdown file has changed. Refresh and try again. Current version: ${currentVersion}`,
    409,
  );
}
