import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface ProjectSoul {
  name: string;
  what: string;
  mood: string;
  style: string;
  never: string[];
  audience: string[];
  seek: string[];
  title: string;
  launch: string;
  constraint: string;
}

const EMPTY: ProjectSoul = {
  name: '',
  what: '',
  mood: '',
  style: '',
  never: [],
  audience: [],
  seek: [],
  title: '',
  launch: '',
  constraint: '',
};

export async function loadProjectSoul(workspaceDir: string): Promise<ProjectSoul | null> {
  try {
    const text = await readFile(path.join(workspaceDir, 'SOUL.md'), 'utf8');
    const soul = parseProjectSoul(text);
    return soul.what || soul.launch || soul.mood ? soul : null;
  } catch {
    return null;
  }
}

export function parseProjectSoul(markdown: string): ProjectSoul {
  const soul = { ...EMPTY, never: [] as string[] };
  for (const line of markdown.split('\n')) {
    const match = /^([A-Za-z]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1]?.toLowerCase() ?? '';
    const value = (match[2] ?? '').trim();
    if (key === 'name') soul.name = value;
    else if (key === 'what') soul.what = value;
    else if (key === 'mood') soul.mood = value;
    else if (key === 'style') soul.style = value;
    else if (key === 'never') soul.never = splitList(value);
    else if (key === 'audience') soul.audience = splitList(value);
    else if (key === 'seek') soul.seek = splitList(value).map((item) => item.replace(/^"|"$/g, ''));
    else if (key === 'title') soul.title = value;
    else if (key === 'launch') soul.launch = value;
    else if (key === 'constraint') soul.constraint = value;
  }
  return soul;
}

export function seekPhrases(soul: ProjectSoul): string[] {
  if (soul.seek.length > 0) return soul.seek.slice(0, 3);
  const phrases: string[] = [];
  const audience = soul.audience.join(' ').toLowerCase();
  if (audience.includes('truck')) phrases.push('truck simulator');
  if (audience.includes('solana')) phrases.push('solana gaming');
  if (audience.includes('prize') || audience.includes('young')) phrases.push('prize pool');
  return phrases.slice(0, 3);
}

function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

export function briefMatchesSoul(text: string, soul: ProjectSoul): boolean {
  const haystack = text.toLowerCase();
  const words = `${soul.what} ${soul.title}`.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((word) => word.length > 4);
  const hits = new Set(words.filter((word) => haystack.includes(word)));
  return hits.size >= 2;
}
