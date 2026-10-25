/** Deterministic Host plugins loaded from the preview's writable profile directory. */
import { workerAuthoringPrompt } from '@deepseek-ai/dsh-experimental-webworker-packer/src/worker-authoring.ts'

/** Profile populated by the Worker fixture. */
export const HMR_PROFILE = '/dsh/home/profiles/web'

/** @returns Pre-lowered module files and a profile patch for the real Worker boot. */
export function workerHmrFiles(): Record<string, string> {
  const greeting = /\n(exports.name = 'local-greeting';[\s\S]*?\n};)\n/.exec(workerAuthoringPrompt('/dsh', 'web'))?.[1]
  if (greeting === undefined) throw new Error('Worker guidance has no executable greeting example')
  const plugin = (id: string): string => `
const shared = require('./shared.js');
exports.inject = ['hmrProbe'];
exports.apply = ctx => ctx.effect(() => ctx.hmrProbe.register('${id}', shared.value));
`
  const rows = ['controller', 'a', 'b', 'unrelated'].map(id => ({
    id: `hmr-probe-${id}`, name: `file://${HMR_PROFILE}/plugins/${id}.js`,
  }))
  return {
    'home/profiles/web/cordis.patch.yml': JSON.stringify([
      { id: 'hmr', config: {
        root: [`${HMR_PROFILE}/plugins`],
        ignored: [], debounce: 20,
      } },
      { insert: rows },
    ]),
    'home/profiles/web/plugins/a.js': plugin('a'),
    'home/profiles/web/plugins/b.js': plugin('b'),
    'home/profiles/web/plugins/shared.js': "exports.value = 'v1';",
    'home/profiles/web/plugins/unrelated.js': `
exports.inject = ['hmrProbe'];
exports.apply = ctx => ctx.effect(() => ctx.hmrProbe.register('unrelated', 'stable'));
`,
    'home/profiles/web/plugins/controller.js': `
const fs = require('node:fs');
const { LlmAdapter, createUserMessage } = require('@deepseek-ai/dsh-llm');
exports.inject = ['webServer', 'hmr', 'systemPrompt', 'llm', 'agents', 'agentPresets'];
exports.apply = ctx => {
  const rows = {};
  const events = [];
  const boot = Math.random();
  const requests = [];
  let agent;
  class ProbeAdapter extends LlmAdapter {
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
    async * stream(options) {
      requests.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'ok' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['worker-authoring-probe'], new ProbeAdapter());
  ctx.provide('hmrProbe', {
    register(id, value) {
      if (rows[id]) throw new Error('duplicate registration: ' + id);
      rows[id] = value;
      events.push('start:' + id + ':' + value);
      return () => { delete rows[id]; events.push('stop:' + id + ':' + value); };
    },
  });
  const reply = (res, value) => { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify(value)); };
  const route = (path, handler) => ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }));
  route('/hmr-probe/authoring-status', async (_req, res) => {
    const assembly = await ctx.systemPrompt.assemble();
    reply(res, { greeting: assembly.sections.find(section => section.name === 'local:greeting')?.text });
  });
  route('/hmr-probe/authoring-request', async (_req, res) => {
    agent ??= (await ctx.agents.create({
      sessionId: 'worker-authoring-probe', meta: { cwd: '/dsh/workspace' },
      agentOptions: { provider: 'worker-authoring-probe', model: 'echo' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'cordis').then(() => {}),
    })).agent;
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'WORKER_HELLO' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    const system = requests.findLast(request => request.purpose === undefined)?.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\\n');
    const logged = agent.session.snapshotEvents().filter(event => event.type === 'system/message')
      .flatMap(event => event.data.message.content.filter(block => block.type === 'text').map(block => block.text));
    reply(res, { system, logged });
  });
  for (const version of ['v1', 'v2']) {
    route('/hmr-probe/authoring-' + version, (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      fs.writeFileSync('${HMR_PROFILE}/plugins/local-greeting.js', ${JSON.stringify(greeting)}.replace('plugin v1.', 'plugin ' + version + '.'));
      if (version === 'v1') {
        const patch = JSON.parse(fs.readFileSync('${HMR_PROFILE}/cordis.patch.yml', 'utf8'));
        patch.push({ insert: [{ id: 'local-greeting', name: 'file://${HMR_PROFILE}/plugins/local-greeting.js' }] });
        fs.writeFileSync('${HMR_PROFILE}/cordis.patch.yml', JSON.stringify(patch));
      }
      reply(res, { written: true });
    });
  }
  route('/hmr-probe/status', (_req, res) => reply(res, { boot, rows, events }));
  route('/hmr-probe/protected', async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const path = '/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';
    fs.writeFileSync(path, fs.readFileSync(path, 'utf8') + '\\n');
    reply(res, await ctx.hmr.runExclusive(() => ctx.hmr.reconcileProfile()));
  });
  for (const [name, source] of Object.entries({
    v2: "exports.value = 'v2';",
    broken: "throw new Error('intentional HMR fixture failure');",
    v3: "exports.value = 'v3';",
  })) {
    route('/hmr-probe/' + name, (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      fs.writeFileSync('${HMR_PROFILE}/plugins/shared.js', source);
      reply(res, { written: true });
    });
  }
  for (const enabled of [false, true]) {
    route('/hmr-probe/' + (enabled ? 'add' : 'remove'), (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      const patch = JSON.parse(fs.readFileSync('${HMR_PROFILE}/cordis.patch.yml', 'utf8'));
      patch[1].insert = ${JSON.stringify(rows)}.filter(row => enabled || row.id !== 'hmr-probe-b');
      fs.writeFileSync('${HMR_PROFILE}/cordis.patch.yml', JSON.stringify(patch));
      reply(res, { written: true });
    });
  }
};
`,
  }
}
