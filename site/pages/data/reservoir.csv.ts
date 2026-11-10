import { reservoirRows, toCsv } from "../../../src/export.ts";
import { db } from "../../lib/data.ts";

export const GET = () => new Response(toCsv(reservoirRows(db())));
