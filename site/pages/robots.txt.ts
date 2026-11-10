import { SITE_URL } from "../../src/config.ts";
import { robotsTxt } from "../../src/export.ts";

export const GET = () => new Response(robotsTxt(SITE_URL));
