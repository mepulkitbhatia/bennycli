import { readFileTool } from "./read.ts";
import type { Tool } from "./tool.ts";

// Every tool Benny offers the model. Adding a tool means adding it here.
export const tools: Tool[] = [readFileTool];
