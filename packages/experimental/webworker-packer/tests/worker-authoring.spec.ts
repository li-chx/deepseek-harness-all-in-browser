/** The deployment guidance matches its recorded-request golden and documented examples. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { workerAuthoringPrompt } from '../src/worker-authoring.ts'

it('pins the complete guidance shared by the image, README pair and recorded Worker requests', () => {
  const prompt = workerAuthoringPrompt('/dsh', 'web')
  const golden = readFileSync(new URL('../../../../apps/web/tests/expected/worker-hmr/authoring-prompt.expected.md', import.meta.url), 'utf8')
  expect(golden.split('\n\nObserved plugin instructions across two recorded requests:')[0]).toBe(prompt)
  for (const name of ['README.md', 'README.zh.md']) {
    const readme = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
    expect(readme).toContain('```markdown\n' + prompt + '\n```')
  }
})

it('uses the selected profile for Forge commands and the mounted root for direct JS and storage paths', () => {
  const prompt = workerAuthoringPrompt('/virtual', 'custom')
  expect(prompt).toContain('dsh plugin --profile "custom" build ./greeting-source')
  expect(prompt).toContain('dsh plugin --profile "custom" remove local-greeting')
  expect(prompt).toContain('"/virtual/home/profiles/custom/cordis.patch.yml"')
  expect(prompt).toContain('file:///virtual/home/profiles/custom/plugins/local-greeting.js')
  expect(prompt).toContain('"/virtual/workspace"')
  expect(prompt).not.toContain('"/dsh')
  expect(prompt).not.toContain('file:///dsh/')
  const manifestLine = prompt.split('\n').find(line => line.startsWith('{"id":"local-greeting"'))
  expect(manifestLine).toBeDefined()
  const manifest: unknown = JSON.parse(manifestLine ?? '')
  expect(manifest).toEqual({ id: 'local-greeting', name: 'local-greeting', version: '1.0.0', entry: 'index.js', files: ['index.js'] })
  const example = /\n(exports.name = 'local-greeting';[\s\S]*?\n};)\n/.exec(prompt)?.[1]
  expect(example).toContain("exports.inject = ['systemPrompt'];")
  expect(example).toContain('WORKER_HELLO')
})
