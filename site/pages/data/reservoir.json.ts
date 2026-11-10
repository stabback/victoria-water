import { reservoirRows } from "../../../src/export.ts";
import { db } from "../../lib/data.ts";

export const GET = () => Response.json(reservoirRows(db()));
