import { sourceList } from "../../../src/analysis/dashboard.ts";
import { sourceFiles } from "../../../src/export.ts";
import { db } from "../../lib/data.ts";

export const GET = () => Response.json({ sources: sourceList(), files: sourceFiles(db()) });
