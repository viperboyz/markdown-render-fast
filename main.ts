// Driver for the markdown-render-fast entry.
// Reads every case from cases.json, renders each one with parse() from
// ./parse.js, and writes the HTML strings (in case order) to html.json.
// Runs under Node with type stripping, so this file uses erasable
// TypeScript only: no enums, no parameter properties, no namespaces.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

const inputDir: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw: string = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases: Case[] = JSON.parse(raw) as Case[];

// Render each case on its own so one document never leaks state into the next.
const html: string[] = cases.map((c: Case): string => parse(c.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
