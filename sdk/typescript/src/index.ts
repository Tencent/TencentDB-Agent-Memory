/**
 * @tencentdb-agent-memory/memory-sdk-ts — TypeScript SDK for TencentDB Agent Memory v2 API.
 */

export { MemoryClient, type MemoryClientConfig, type Transport } from "./client.js";
export { TDAMError } from "./errors.js";
export { HttpTransport, type HttpTransportOptions } from "./http.js";
export { MemoryFileReader, StsCredentialManager, StsCredential, createMemoryFileReader, cosV5Sign, type MemoryFileReaderConfig } from "./cos.js";
export type * from "./types.js";
