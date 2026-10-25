import { editFileTool } from "./edit.ts";
import { listDirTool } from "./list.ts";
import { readFileTool } from "./read.ts";
import { searchTool } from "./search.ts";
import type { Tool } from "./tool.ts";
import { writeFileTool } from "./write.ts";

// Every tool Benny offers the model. Adding a tool means adding it here.
export const tools: Tool[] = [readFileTool, listDirTool, searchTool, editFileTool, writeFileTool];
