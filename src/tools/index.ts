import { listDirTool } from "./list.ts";
import { readFileTool } from "./read.ts";
import { searchTool } from "./search.ts";
import type { Tool } from "./tool.ts";

// Every tool Benny offers the model. Adding a tool means adding it here.
export const tools: Tool[] = [readFileTool, listDirTool, searchTool];
