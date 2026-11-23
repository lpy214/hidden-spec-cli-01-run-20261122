// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that applies
// AI-written edits in four formats (unified diff, SEARCH/REPLACE blocks, V4A patches
// and JSON edits) to a tree of text files, finding the lines an edit names at the
// first of three matching tiers, and changing every file or none.
//
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with a break. */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(m: FileModel): string {
  return m.lines.length === 0 ? '' : m.lines.join(m.br) + (m.final ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order, for the `R old -> new` output lines. */
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  recordMove(old: string, nw: string): void {
    this.moves.push({ old, new: nw });
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** SPEC.md section 5: one line normalised at a tier. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in lines at a tier; occurrences may overlap. */
function occurrencesAt(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its occurrences; null when none. */
function findMatch(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a hunk or chunk: context, old (`-`), new (`+`) or backslash. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/** One line of O or N. `ctx` is the line's index in O for a context line, else null. */
interface ONLine {
  text: string;
  ctx: number | null;
}

/** Split a hunk/chunk body into O (context and `-` lines) and N (context and `+` lines). */
function buildON(body: BodyLine[]): { o: ONLine[]; n: ONLine[] } {
  const o: ONLine[] = [];
  const n: ONLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const idx = o.length;
      o.push({ text: b.text, ctx: idx });
      n.push({ text: b.text, ctx: idx });
    } else if (b.kind === 'old') {
      o.push({ text: b.text, ctx: null });
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

/**
 * Render N at matched position `pos`: a context line is written as the file's own
 * matched line; at tier 2 every other non-empty, non-whitespace-only line that starts
 * with P (the leading spaces/tabs of O's first line) has that P replaced by F (those
 * of the file's first matched line). At tiers 0 and 1 N is written as it is.
 */
function renderN(n: ONLine[], fileLines: string[], pos: number, tier: number, oFirst: string | null): string[] {
  let p = '';
  let f = '';
  if (tier === 2 && oFirst !== null) {
    p = leadWS(oFirst);
    f = leadWS(fileLines[pos] ?? '');
  }
  return n.map((e) => {
    if (e.ctx !== null) return fileLines[pos + e.ctx]!;
    const t = e.text;
    if (tier === 2 && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/** Whether a `\` line follows the body's last context or `+` line. */
function backslashAfterLastCP(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') last = k;
  }
  if (last < 0) return false;
  return last + 1 < body.length && body[last + 1]!.kind === 'bs';
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** The A of `@@ -A[,B] +C[,D] @@`: the 1-based old line the hunk starts at. */
  a: number;
  body: BodyLine[];
}

interface Section {
  /** Null means `/dev/null` (no file). */
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  /** True when the section's own `---`/`+++` pair named its paths. */
  hasPair: boolean;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, trimmed, `a/`/`b/` removed. */
function headerPath(l: string): string | null {
  const raw = l.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseHunkHeader(l: string, idx: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
  if (!m) throw new Exit2(`error: parse ${idx + 1}`);
  return parseInt(m[1]!, 10);
}

/** Collect a hunk's body starting after its header line at `start`. */
function collectHunk(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  const body: BodyLine[] = [];
  let j = start + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '' });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'bs', text: l.slice(1) });
      j++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
  return { hunk: { a, body }, next: j };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        oldPath: m[1]!,
        newPath: m[2]!,
        renameFrom: null,
        renameTo: null,
        hasPair: false,
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      sections.push(cur);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
        cur.oldPath = headerPath(l);
        cur.newPath = headerPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        cur = {
          oldPath: headerPath(l),
          newPath: headerPath(lines[i + 1]!),
          renameFrom: null,
          renameTo: null,
          hasPair: true,
          isCreate: false,
          isDelete: false,
          hunks: [],
        };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (cur.hunks.length === 0) {
      if (l.startsWith('@@')) {
        const a = parseHunkHeader(l, i);
        const { hunk, next } = collectHunk(lines, i, a);
        cur.hunks.push(hunk);
        i = next;
        continue;
      }
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const a = parseHunkHeader(l, i);
      const { hunk, next } = collectHunk(lines, i, a);
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    i++;
  }
  return sections;
}

/** Apply a section's hunks in order to a file's text; throws Fail on a bad hunk. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const model = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = buildON(h.body);
    const oTexts = o.map((e) => e.text);
    if (oTexts.length === 0) {
      const idx = Math.max(0, Math.min(h.a + d, model.lines.length));
      const atEnd = idx === model.lines.length;
      const rep = n.map((e) => e.text);
      model.lines = [...model.lines.slice(0, idx), ...rep, ...model.lines.slice(idx)];
      if (atEnd) model.final = !backslashAfterLastCP(h.body);
      d += n.length - o.length;
      continue;
    }
    const m = findMatch(model.lines, oTexts, strict);
    if (m === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = m.occ[0]!;
    let best = Math.abs(pos - target);
    for (const p of m.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        pos = p;
        best = dist;
      }
    }
    const atEnd = pos + oTexts.length === model.lines.length;
    const rep = renderN(n, model.lines, pos, m.tier, oTexts[0]!);
    model.lines = [...model.lines.slice(0, pos), ...rep, ...model.lines.slice(pos + oTexts.length)];
    if (atEnd) model.final = !backslashAfterLastCP(h.body);
    d += n.length - o.length;
  }
  return joinFile(model);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    const oldP = sec.hasPair ? sec.oldPath : (sec.renameFrom ?? sec.oldPath);
    const newP = sec.hasPair ? sec.newPath : (sec.renameTo ?? sec.newPath);
    const isCreate = oldP === null || sec.isCreate;
    const isDelete = !isCreate && (newP === null || sec.isDelete);
    const isMove = !isCreate && !isDelete && oldP !== newP;
    if (isCreate) {
      return (tree: Tree) => {
        const p = newP ?? '';
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
        let noBreak = false;
        for (let hi = sec.hunks.length - 1; hi >= 0 && !noBreak; hi--) {
          const body = sec.hunks[hi]!.body;
          let lastPlus = -1;
          for (let k = 0; k < body.length; k++) if (body[k]!.kind === 'new') lastPlus = k;
          if (lastPlus >= 0) noBreak = lastPlus + 1 < body.length && body[lastPlus + 1]!.kind === 'bs';
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      };
    }
    if (isDelete) {
      return (tree: Tree) => {
        const p = oldP ?? '';
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    if (isMove) {
      const op = oldP!;
      const np = newP!;
      return (tree: Tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const cur = tree.get(op);
        if (cur === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const result = applyHunks(cur, sec.hunks, strict, op);
        tree.now.set(op, null);
        tree.now.set(np, result);
        tree.recordMove(op, np);
      };
    }
    const p = oldP!;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(cur, sec.hunks, strict, p));
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (trimEndWS(lines[j]!) === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let p: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (l.trim() === '') continue;
      if (l.trim().startsWith('```')) continue;
      p = l.trim();
      break;
    }
    if (p === null) p = prevPath;
    if (p === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = trimEndWS(lines[j]!);
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (trimEndWS(lines[j]!) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const path = p;
    edits.push((tree: Tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      const model = splitFile(cur);
      const m = findMatch(model.lines, oldLines, strict);
      if (m === null) throw new Fail('no-match', path);
      if (m.occ.length > 1) throw new Fail('ambiguous', path);
      const pos = m.occ[0]!;
      const repLines = renderN(
        newLines.map((t) => ({ text: t, ctx: null })),
        model.lines,
        pos,
        m.tier,
        oldLines[0]!,
      );
      model.lines = [...model.lines.slice(0, pos), ...repLines, ...model.lines.slice(pos + oldLines.length)];
      tree.now.set(path, joinFile(model));
    });
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  /** Null or '' means no anchor. */
  anchor: string | null;
  body: BodyLine[];
  /** True when a `*** End of File` line closed this chunk. */
  eof: boolean;
}

function v4aBodyKind(l: string): BodyLine['kind'] | null {
  if (l === '') return 'ctx';
  const c = l[0]!;
  if (c === ' ') return 'ctx';
  if (c === '-') return 'old';
  if (c === '+') return 'new';
  return null;
}

function parseV4aUpdate(
  secLines: { text: string; idx: number }[],
  updateLineIdx: number,
): { moveTo: string | null; chunks: V4aChunk[] } {
  let k = 0;
  let moveTo: string | null = null;
  if (k < secLines.length && secLines[k]!.text.startsWith('*** Move to: ')) {
    moveTo = secLines[k]!.text.slice('*** Move to: '.length).trim();
    k++;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let started = false;
  for (; k < secLines.length; k++) {
    const sl = secLines[k]!;
    const l = sl.text;
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim(), body: [], eof: false };
      chunks.push(cur);
      started = true;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${sl.idx + 1}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    const kind = v4aBodyKind(l);
    if (kind === null) throw new Exit2(`error: parse ${sl.idx + 1}`);
    if (cur === null) {
      if (started) throw new Exit2(`error: parse ${sl.idx + 1}`);
      cur = { anchor: null, body: [], eof: false };
      chunks.push(cur);
      started = true;
    }
    cur.body.push({ kind, text: l === '' ? '' : l.slice(1) });
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineIdx + 1}`);
  return { moveTo, chunks };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const isAdd = l.startsWith('*** Add File: ');
      const isDelete = l.startsWith('*** Delete File: ');
      const prefix = isAdd ? '*** Add File: ' : isDelete ? '*** Delete File: ' : '*** Update File: ';
      const p = l.slice(prefix.length).trim();
      const updateLineIdx = i;
      let j = i + 1;
      const secLines: { text: string; idx: number }[] = [];
      while (j < last && !isSectionStart(lines[j]!)) {
        secLines.push({ text: lines[j]!, idx: j });
        j++;
      }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
      if (isAdd) {
        const fileLines: string[] = [];
        for (const sl of secLines) {
          if (sl.text.startsWith('+')) fileLines.push(sl.text.slice(1));
          else if (sl.text === '') fileLines.push('');
          else throw new Exit2(`error: parse ${sl.idx + 1}`);
        }
        const path = p;
        edits.push((tree: Tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) !== null) throw new Fail('exists', path);
          tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
        });
      } else if (isDelete) {
        if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0]!.idx + 1}`);
        const path = p;
        edits.push((tree: Tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) === null) throw new Fail('missing', path);
          tree.now.set(path, null);
        });
      } else {
        const { moveTo, chunks } = parseV4aUpdate(secLines, updateLineIdx);
        const path = p;
        edits.push((tree: Tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
          const cur = tree.get(path);
          if (cur === null) throw new Fail('missing', path);
          if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
          const model = splitFile(cur);
          let cursor = 0;
          for (const ch of chunks) {
            if (ch.anchor !== null && ch.anchor !== '') {
              let found = -1;
              for (const t of strict ? [0] : [0, 1, 2]) {
                for (let j = cursor; j < model.lines.length; j++) {
                  if (normLine(model.lines[j]!, t) === normLine(ch.anchor, t)) {
                    found = j;
                    break;
                  }
                }
                if (found >= 0) break;
              }
              if (found < 0) throw new Fail('no-match', path);
              cursor = found + 1;
            }
            const { o, n } = buildON(ch.body);
            const oTexts = o.map((e) => e.text);
            if (oTexts.length === 0) {
              const idx = ch.eof ? model.lines.length : cursor;
              const rep = n.map((e) => e.text);
              model.lines = [...model.lines.slice(0, idx), ...rep, ...model.lines.slice(idx)];
              cursor = idx + rep.length;
              continue;
            }
            let found: { tier: number; pos: number } | null = null;
            for (const t of strict ? [0] : [0, 1, 2]) {
              const occ = occurrencesAt(model.lines, oTexts, t).filter(
                (pos) => pos >= cursor && (!ch.eof || pos + oTexts.length === model.lines.length),
              );
              if (occ.length > 0) {
                found = { tier: t, pos: occ[0]! };
                break;
              }
            }
            if (found === null) throw new Fail('no-match', path);
            const rep = renderN(n, model.lines, found.pos, found.tier, oTexts[0]!);
            model.lines = [
              ...model.lines.slice(0, found.pos),
              ...rep,
              ...model.lines.slice(found.pos + oTexts.length),
            ];
            cursor = found.pos + rep.length;
          }
          const text = joinFile(model);
          if (moveTo !== null) {
            tree.now.set(path, null);
            tree.now.set(moveTo, text);
            tree.recordMove(path, moveTo);
          } else {
            tree.now.set(path, text);
          }
        });
      }
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move whose old path existed before the patch and does not after it, and whose
  // new path did not exist before it and does after it, is one `R old -> new` line
  // replacing that pair's `D` and `A` lines; chains of moves collapse to one `R`.
  const next = new Map<string, string>();
  for (const m of tree.moves) if (!next.has(m.old)) next.set(m.old, m.new);
  const isTarget = new Set(tree.moves.map((m) => m.new));
  const suppressedD = new Set<string>();
  const suppressedA = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const m of tree.moves) {
    if (isTarget.has(m.old)) continue;
    let end = m.new;
    const seen = new Set<string>([m.old]);
    while (next.has(end) && !seen.has(end)) {
      seen.add(end);
      end = next.get(end)!;
    }
    if (tree.original(m.old) !== null && tree.original(end) === null && tree.get(m.old) === null && tree.get(end) !== null) {
      rows.push({ key: end, line: `R ${m.old} -> ${end}` });
      suppressedD.add(m.old);
      suppressedA.add(end);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) {
      if (!suppressedA.has(p)) rows.push({ key: p, line: `A ${p}` });
    } else if (now === null) {
      if (!suppressedD.has(p)) rows.push({ key: p, line: `D ${p}` });
    } else {
      rows.push({ key: p, line: `M ${p}` });
    }
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
