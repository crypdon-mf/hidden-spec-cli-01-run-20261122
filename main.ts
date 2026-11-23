// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output
// and exit codes, safe paths, format detection, line matching at three tiers, unified diffs, SEARCH/REPLACE blocks,
// V4A patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** A file's own line break, its lines and whether it ends with a break (SPEC.md section 3). */
function splitFile(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(br: string, lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const wsOnly = (s: string): boolean => /^[ \t]*$/.test(s);

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves the edits performed, as (old, new) pairs, for the `R` output lines. */
  readonly moves: [string, string][] = [];
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
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
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

// ---- Section 5: matching lines at three tiers ----

/** Positions where O occurs in F at the tier (occurrences may overlap). */
function occurrences(O: string[], F: string[], tier: number): number[] {
  if (O.length === 0) return [];
  const norm = tier === 0 ? (s: string): string => s : tier === 1 ? stripTrail : stripBoth;
  const on = O.map(norm);
  const out: number[] = [];
  for (let i = 0; i + O.length <= F.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (norm(F[i + k]!) !== on[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs in F at or after `from`, with its positions, or null. */
function findMatch(O: string[], F: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  if (O.length === 0) return null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos = occurrences(O, F, tier).filter((p) => p >= from);
    if (pos.length > 0) return { tier, positions: pos };
  }
  return null;
}

interface NewLine {
  text: string;
  /** Index into O of the context line this new line repeats, or null for a line only N has. */
  ctx: number | null;
}

/** Replace O's lines at `pos` with N: context lines are written as the file's own matched lines, and at tier 2
 * every other line of N is re-indented from O's first line's leading whitespace to the file's. */
function applyAt(lines: string[], pos: number, O: string[], N: NewLine[], tier: number): string[] {
  const F = leadingWs(lines[pos] ?? '');
  const P = O.length > 0 ? leadingWs(O[0]!) : '';
  const rep = N.map((n) => {
    if (n.ctx !== null) return lines[pos + n.ctx]!;
    if (tier === 2) {
      const t = n.text;
      if (t !== '' && !wsOnly(t) && t.startsWith(P)) return F + t.slice(P.length);
    }
    return n.text;
  });
  const out = [...lines];
  out.splice(pos, O.length, ...rep);
  return out;
}

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  raw: string;
}

/** Split a hunk or chunk body into its old lines O and its new lines N (with context links). */
function bodyON(body: BodyLine[]): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === '-') O.push(b.text);
    else if (b.kind === '+') N.push({ text: b.text, ctx: null });
  }
  return { O, N };
}

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | null | undefined;
  renameNew: string | null | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, `a/`/`b/` stripped; `/dev/null` is no file. */
function diffPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(body: BodyLine[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    if (body[j]!.kind === ' ' || body[j]!.kind === '+') last = j;
  }
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next.kind === '\\';
}

/** Apply a section's hunks in order to a file's text, returning the new text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let { br, lines, final } = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = bodyON(h.body);
    if (O.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...N.map((n) => n.text), ...lines.slice(at)];
      if (atEnd) final = !backslashAfterLast(h.body);
    } else {
      const m = findMatch(O, lines, strict, 0);
      if (m === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = m.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of m.positions) {
        const dd = Math.abs(p - target);
        if (dd < best) {
          best = dd;
          pos = p;
        }
      }
      const runsToEnd = pos + O.length === lines.length;
      lines = applyAt(lines, pos, O, N, m.tier);
      if (runsToEnd) final = !backslashAfterLast(h.body);
    }
    d += N.length - O.length;
  }
  return joinFile(br, lines, final);
}

function unifiedSectionEdit(
  oldPath: string | null,
  newPath: string | null,
  isCreate: boolean,
  isDelete: boolean,
  hunks: Hunk[],
  strict: boolean,
): Edit {
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    const create = isCreate || oldPath === null;
    const del = !create && (isDelete || newPath === null);
    if (create) {
      if (newPath === null) return;
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const lines: string[] = [];
      let lastPlus: { h: number; j: number } | null = null;
      hunks.forEach((h, hi) => {
        h.body.forEach((b, j) => {
          if (b.kind === '+') {
            lines.push(b.text);
            lastPlus = { h: hi, j };
          }
        });
      });
      let finalBreak = true;
      if (lastPlus !== null) {
        const next = hunks[lastPlus.h]!.body[lastPlus.j + 1];
        if (next !== undefined && next.kind === '\\') finalBreak = false;
      }
      tree.now.set(newPath, lines.length === 0 ? '' : lines.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (del) {
      const op = oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldPath !== newPath) {
      const op = oldPath!;
      const np = newPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(tree.get(op)!, hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, out);
      tree.moves.push([op, np]);
      return;
    }
    const p = oldPath!;
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(tree.get(p)!, hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const start = (gitOld: string | null, gitNew: string | null): USection => {
    const s: USection = {
      gitOld,
      gitNew,
      pairOld: undefined,
      pairNew: undefined,
      renameOld: undefined,
      renameNew: undefined,
      create: false,
      del: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (m === null || m[1]!.trim() === '' || m[2]!.trim() === '') throw new Exit2(`error: parse ${i + 1}`);
      start(m[1]!.trim(), m[2]!.trim());
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: BodyLine[] = [];
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        // A `--- ` line followed by a `+++ ` line ends the body (and starts a new section), even though it
        // starts with `-`; a `diff --git ` line ends it too.
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          body.push({ kind: ' ', text: '', raw: b });
          i += 1;
        } else if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push({ kind: b[0] as BodyLine['kind'], text: b.slice(1), raw: b });
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('--- ')) {
      const nxt = lines[i + 1];
      if (nxt === undefined || !nxt.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      cur.pairOld = diffPath(l.slice(4));
      cur.pairNew = diffPath(nxt.slice(4));
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = start(null, null);
      s.pairOld = diffPath(l.slice(4));
      s.pairNew = diffPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) cur.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((sec) => {
    const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.gitOld;
    const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.gitNew;
    return unifiedSectionEdit(oldPath, newPath, sec.create, sec.del, sec.hunks, strict);
  });
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const { br, lines, final } = splitFile(text);
    const m = findMatch(oldLines, lines, strict, 0);
    if (m === null) throw new Fail('no-match', path);
    if (m.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = m.positions[0]!;
    const rep = newLines.map((t) => {
      if (m.tier === 2) {
        const F = leadingWs(lines[pos] ?? '');
        const P = leadingWs(oldLines[0]!);
        if (t !== '' && !wsOnly(t) && t.startsWith(P)) return F + t.slice(P.length);
      }
      return t;
    });
    const out = [...lines];
    out.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(br, out, final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aSectionStart(l: string): { kind: string; path: string } | null {
  for (const kind of ['Add File', 'Delete File', 'Update File']) {
    const prefix = `*** ${kind}: `;
    if (l.startsWith(prefix)) return { kind, path: l.slice(prefix.length).trim() };
  }
  return null;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let { br, lines, final } = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const am = findMatch([ch.anchor], lines, strict, cursor);
        if (am === null) throw new Fail('no-match', path);
        cursor = am.positions[0]! + 1;
      }
      const { O, N } = bodyON(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...N.map((n) => n.text), ...lines.slice(at)];
        cursor = at + N.length;
      } else {
        const m = findMatch(O, lines, strict, cursor);
        if (m === null) throw new Fail('no-match', path);
        let pos: number | undefined;
        for (const p of m.positions) {
          if (ch.eof && p + O.length !== lines.length) continue;
          pos = p;
          break;
        }
        if (pos === undefined) throw new Fail('no-match', path);
        lines = applyAt(lines, pos, O, N, m.tier);
        cursor = pos + N.length;
      }
    }
    const out = joinFile(br, lines, final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const ss = v4aSectionStart(l);
    if (ss === null) throw new Exit2(`error: parse ${i + 1}`);
    if (ss.kind === 'Add File') {
      i += 1;
      const fileLines: { text: string; plus: boolean }[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (v4aSectionStart(b) !== null) break;
        if (b.startsWith('+')) {
          fileLines.push({ text: b.slice(1), plus: true });
          i += 1;
        } else if (blank(b)) {
          fileLines.push({ text: '', plus: false });
          i += 1;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && !fileLines[fileLines.length - 1]!.plus) fileLines.pop();
      edits.push(v4aAddEdit(ss.path, fileLines.map((f) => f.text)));
      continue;
    }
    if (ss.kind === 'Delete File') {
      edits.push(v4aDeleteEdit(ss.path));
      i += 1;
      continue;
    }
    const updateLine = i;
    i += 1;
    let moveTo: string | null = null;
    if (i < last && (lines[i]!.startsWith('*** Move to: ') || lines[i]! === '*** Move to:')) {
      moveTo = lines[i]!.slice('*** Move to:'.length).trim();
      i += 1;
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    let started = false;
    while (i < last) {
      const b = lines[i]!;
      if (v4aSectionStart(b) !== null) break;
      if (b.startsWith('@@')) {
        if (cur !== null) chunks.push(cur);
        const anchorText = b.slice(2).trim();
        cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
        started = true;
        i += 1;
        continue;
      }
      if (b === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
        cur.eof = true;
        chunks.push(cur);
        cur = null;
        i += 1;
        continue;
      }
      if (b.startsWith('***')) throw new Exit2(`error: parse ${i + 1}`);
      if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
        if (cur === null) {
          if (started || chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
          cur = { anchor: null, eof: false, body: [] };
          started = true;
        }
        cur.body.push(b === '' ? { kind: ' ', text: '', raw: b } : { kind: b[0] as BodyLine['kind'], text: b.slice(1), raw: b });
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur !== null) {
      while (cur.body.length > 0 && blank(cur.body[cur.body.length - 1]!.raw)) cur.body.pop();
      chunks.push(cur);
      cur = null;
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
    edits.push(v4aUpdateEdit(ss.path, moveTo, chunks, strict));
  }
  return edits;
}

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
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { key: string; line: string }[] = [];
  const skipOld = new Set<string>();
  const skipNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      skipOld.add(oldP);
      skipNew.add(newP);
      changed.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  const sortedPaths = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of sortedPaths) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (skipOld.has(p) || skipNew.has(p)) continue;
    changed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.line);
  if (!check) {
    for (const p of sortedPaths) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
