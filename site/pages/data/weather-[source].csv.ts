import type { APIRoute } from "astro";
import { toCsv, WEATHER_SOURCES, type WeatherSource, weatherRows } from "../../../src/export.ts";
import { db } from "../../lib/data.ts";

export const getStaticPaths = () => WEATHER_SOURCES.map((source) => ({ params: { source } }));

export const GET: APIRoute = ({ params }) => new Response(toCsv(weatherRows(db(), params.source as WeatherSource)));
