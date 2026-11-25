/**
 * @fileoverview GET /api/sessions/:id/slash-commands: what the chat view's `/` menu offers.
 *
 * Pinned: the transcript's skill listing comes first (plugin skills included), the workspace's
 * and the user's skill and command files fill in what it lacks, the built-in commands come
 * last, and a session whose CLI keeps no Claude transcript gets an empty list.
 *
 * Uses app.inject() with a temporary HOME; no real ports or user files.
 * Port: N/A
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { readSlashCommandFiles } from '../../src/claude-slash-command-files.js';

// The real reader, wrapped so a test can tell whether the route reached it.
vi.mock('../../src/claude-slash-command-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude-slash-command-files.js')>();
  return { ...actual, readSlashCommandFiles: vi.fn(actual.readSlashCommandFiles) };
});

const listing = (names: string[], content: string, isInitial = true) =>
  JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', names, content, isInitial } });

describe('GET /api/sessions/:id/slash-commands', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let home: string;
  let workspace: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    vi.mocked(readSlashCommandFiles).mockClear();
    home = mkdtempSync(join(tmpdir(), 'codeman-slash-'));
    workspace = join(home, 'project');
    mkdirSync(workspace, { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = home;
    app = Fastify({ logger: false });
    ctx = createMockRouteContext();
    registerSessionRoutes(app, ctx);
    await app.ready();
    const session = ctx._session as typeof ctx._session & { claudeSessionId: string | null };
    session.mode = 'claude';
    session.workingDir = workspace;
    session.claudeSessionId = 'conv-1';
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    await app.close();
  });

  const write = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };

  async function commands() {
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${ctx._session.id}/slash-commands` });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { data: { commands: { name: string; description: string; kind: string }[] } }).data
      .commands;
  }

  it('lists the transcript skills, then skill and command files, then the built-ins', async () => {
    write(
      join(home, '.claude', 'projects', '-project', 'conv-1.jsonl'),
      [
        listing(['mdr-review', 'pdf-tools:pdf'], '- mdr-review: Review a document\n- pdf-tools:pdf: Read PDFs'),
        listing(['late-skill'], '- late-skill: Added later', false),
      ].join('\n')
    );
    write(
      join(home, '.claude', 'skills', 'mdr-review', 'SKILL.md'),
      '---\nname: mdr-review\ndescription: from disk\n---\n'
    );
    write(join(home, '.claude', 'skills', 'fresh', 'SKILL.md'), '---\nname: fresh\ndescription: Not loaded yet\n---\n');
    write(join(workspace, '.claude', 'commands', 'ops', 'deploy.md'), 'Deploy the service\n');

    const list = await commands();
    const byName = new Map(list.map((c) => [c.name, c]));
    expect(byName.get('mdr-review')).toEqual({ name: 'mdr-review', description: 'Review a document', kind: 'skill' });
    expect(byName.get('pdf-tools:pdf')?.description).toBe('Read PDFs');
    expect(byName.get('late-skill')?.description).toBe('Added later');
    expect(byName.get('fresh')?.description).toBe('Not loaded yet');
    expect(byName.get('ops:deploy')).toEqual({
      name: 'ops:deploy',
      description: 'Deploy the service',
      kind: 'command',
    });
    expect(byName.get('compact')?.kind).toBe('builtin');
    expect(list.map((c) => c.name)).toEqual([...list.map((c) => c.name)].sort((a, b) => a.localeCompare(b)));
  });

  it("finds a Docker session's transcript on the host, never at the container path its hook reports", async () => {
    write(
      join(home, '.claude', 'projects', '-project', 'conv-1.jsonl'),
      listing(['docker-skill'], '- docker-skill: Listed in the container')
    );
    (ctx._session as unknown as { docker: unknown }).docker = { containerName: 'codeman-case-x' };
    vi.mocked(ctx.getTranscriptPath).mockReturnValue('/home/agent/.claude/projects/-project/conv-1.jsonl');

    const byName = new Map((await commands()).map((c) => [c.name, c]));
    expect(byName.get('docker-skill')?.description).toBe('Listed in the container');
  });

  it('offers the files and built-ins to a session that has no transcript yet', async () => {
    write(join(workspace, '.claude', 'skills', 'local', 'SKILL.md'), '---\ndescription: >\n  Folded\n  text\n---\n');
    const names = (await commands()).map((c) => c.name);
    expect(names).toContain('local');
    expect(names).toContain('clear');
    // The two refusal tests below lean on this wrapper seeing the route's call.
    expect(readSlashCommandFiles).toHaveBeenCalled();
  });

  it("confines the workspace's files to the workspace, so a link out of it lists nothing", async () => {
    write(join(home, 'secret.md'), 'SECRET-LINE of a private file\n');
    mkdirSync(join(workspace, '.claude', 'commands'), { recursive: true });
    symlinkSync(join(home, 'secret.md'), join(workspace, '.claude', 'commands', 'leak.md'));

    const list = await commands();
    expect(list.map((c) => c.name)).not.toContain('leak');
    expect(list.some((c) => c.description.includes('SECRET-LINE'))).toBe(false);
    const roots = vi.mocked(readSlashCommandFiles).mock.calls[0][0];
    const workspaceRoot = roots.find((r) => r.dir === join(workspace, '.claude'));
    expect(workspaceRoot?.confineTo).toBe(realpathSync(workspace));
  });

  it('answers an empty list for a CLI without a Claude transcript', async () => {
    ctx._session.mode = 'codex';
    expect(await commands()).toEqual([]);
  });

  it('answers an empty list for a remote session without reading any file', async () => {
    write(join(workspace, '.claude', 'skills', 'local', 'SKILL.md'), '---\ndescription: Local\n---\n');
    (ctx._session as unknown as { remote: unknown }).remote = { hostId: 'h1', remoteWorkingDir: workspace };
    expect(await commands()).toEqual([]);
    expect(readSlashCommandFiles).not.toHaveBeenCalled();
  });

  it('answers an empty list for an adopted session without reading any file', async () => {
    write(join(workspace, '.claude', 'skills', 'local', 'SKILL.md'), '---\ndescription: Local\n---\n');
    (ctx._session as unknown as { isAdopted: boolean }).isAdopted = true;
    expect(await commands()).toEqual([]);
    expect(readSlashCommandFiles).not.toHaveBeenCalled();
  });
});
