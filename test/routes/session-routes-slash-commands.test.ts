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
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { readSlashCommandFiles } from '../../src/claude-slash-command-files.js';
import { probePathKind } from '../../src/utils/index.js';

// The real reader, wrapped so a test can tell whether the route reached it.
vi.mock('../../src/claude-slash-command-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude-slash-command-files.js')>();
  return { ...actual, readSlashCommandFiles: vi.fn(actual.readSlashCommandFiles) };
});

// The real bounded probe, wrapped so a test can make one path read as a mount that stopped answering.
vi.mock('../../src/utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/index.js')>();
  return { ...actual, probePathKind: vi.fn(actual.probePathKind) };
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
    // mockReset puts the real probe back after a test that replaced it.
    vi.mocked(probePathKind).mockReset();
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
    // A command file named like a built-in wins over the built-in.
    write(join(workspace, '.claude', 'commands', 'compact.md'), 'Project compact\n');

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
    expect(byName.get('compact')).toEqual({ name: 'compact', description: 'Project compact', kind: 'command' });
    expect(byName.get('clear')?.kind).toBe('builtin');
    expect(list.map((c) => c.name)).toEqual([...list.map((c) => c.name)].sort((a, b) => a.localeCompare(b)));
  });

  it("reads a Docker session's transcript at the host path its watcher follows", async () => {
    write(
      join(home, '.claude', 'projects', '-project', 'conv-1.jsonl'),
      listing(['docker-skill'], '- docker-skill: Listed in the container')
    );
    // The host's own config folder is not the container's, so none of this is offered.
    write(join(home, '.claude', 'skills', 'host-only', 'SKILL.md'), '---\ndescription: Host skill\n---\n');
    write(join(home, '.claude', 'commands', 'host-cmd.md'), 'Host command\n');
    (ctx._session as unknown as { docker: unknown }).docker = { containerName: 'codeman-case-x' };
    // The hook reports the container's path, and the watcher follows the host's copy
    // (hostTranscriptPath in claude-conversation-report.ts).
    vi.mocked(ctx.getTranscriptPath).mockReturnValue(join(home, '.claude', 'projects', '-project', 'conv-1.jsonl'));

    const byName = new Map((await commands()).map((c) => [c.name, c]));
    expect(byName.get('docker-skill')?.description).toBe('Listed in the container');
    expect(byName.has('host-only')).toBe(false);
    expect(byName.has('host-cmd')).toBe(false);
  });

  it('reads the transcript again once it has grown', async () => {
    const transcript = join(home, '.claude', 'projects', '-project', 'conv-1.jsonl');
    write(transcript, listing(['first-skill'], '- first-skill: Listed first'));
    expect((await commands()).map((c) => c.name)).toContain('first-skill');

    appendFileSync(transcript, '\n' + listing(['grown-skill'], '- grown-skill: Listed later', false));
    const names = (await commands()).map((c) => c.name);
    expect(names).toContain('first-skill');
    expect(names).toContain('grown-skill');
  });

  it('skips a transcript whose path the bounded probe cannot answer for', async () => {
    const transcript = join(home, 'stalled', 'conv-1.jsonl');
    write(transcript, listing(['stalled-skill'], '- stalled-skill: Behind a dead mount'));
    write(join(workspace, '.claude', 'skills', 'local', 'SKILL.md'), '---\ndescription: Local\n---\n');
    vi.mocked(ctx.getTranscriptPath).mockReturnValue(transcript);
    const real = await vi.importActual<typeof import('../../src/utils/index.js')>('../../src/utils/index.js');
    vi.mocked(probePathKind).mockImplementation(async (path, options) =>
      path === transcript ? 'unknown' : real.probePathKind(path, options)
    );

    const names = (await commands()).map((c) => c.name);
    expect(names).not.toContain('stalled-skill');
    expect(names).toContain('local');
    expect(names).toContain('clear');
  });

  it('reads the skills of a relocated config folder that has no projects folder yet', async () => {
    const configDir = join(home, 'other-config');
    write(join(configDir, 'skills', 'cfg-skill', 'SKILL.md'), '---\ndescription: From the relocated folder\n---\n');
    (ctx._session as unknown as { claudeConfigDirOverride: string }).claudeConfigDirOverride = configDir;

    const byName = new Map((await commands()).map((c) => [c.name, c]));
    expect(byName.get('cfg-skill')?.description).toBe('From the relocated folder');
  });

  it('leaves out a relocated config folder the bounded probe cannot answer for', async () => {
    const configDir = join(home, 'stalled-config');
    write(join(configDir, 'skills', 'cfg-skill', 'SKILL.md'), '---\ndescription: Behind a dead mount\n---\n');
    write(join(workspace, '.claude', 'skills', 'local', 'SKILL.md'), '---\ndescription: Local\n---\n');
    (ctx._session as unknown as { claudeConfigDirOverride: string }).claudeConfigDirOverride = configDir;
    const real = await vi.importActual<typeof import('../../src/utils/index.js')>('../../src/utils/index.js');
    vi.mocked(probePathKind).mockImplementation(async (path, options) =>
      path === configDir ? 'unknown' : real.probePathKind(path, options)
    );

    const names = (await commands()).map((c) => c.name);
    const roots = vi.mocked(readSlashCommandFiles).mock.calls.flatMap(([passed]) => passed);
    expect(roots.some((root) => root.dir === configDir)).toBe(false);
    expect(roots.some((root) => root.dir === join(workspace, '.claude'))).toBe(true);
    expect(names).not.toContain('cfg-skill');
    expect(names).toContain('local');
    expect(names).toContain('clear');
  });

  it("prefers the workspace's skill over the config folder's of the same name", async () => {
    write(join(workspace, '.claude', 'skills', 'dup', 'SKILL.md'), '---\ndescription: from workspace\n---\n');
    write(join(home, '.claude', 'skills', 'dup', 'SKILL.md'), '---\ndescription: from config\n---\n');

    const byName = new Map((await commands()).map((c) => [c.name, c]));
    expect(byName.get('dup')?.description).toBe('from workspace');
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
