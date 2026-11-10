import { SITE_URL } from "../../src/config.ts";
import { sitemapXml } from "../../src/export.ts";
import { db } from "../lib/data.ts";

export const GET = () => new Response(sitemapXml(db(), SITE_URL));
