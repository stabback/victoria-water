import { dashboard } from "../../lib/data.ts";

export const GET = () => Response.json(dashboard());
