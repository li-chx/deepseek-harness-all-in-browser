/** Registered host executable RPC validation and shell program adapters. */
import type { ShellProgram, ShellFileSystem } from '../types.ts'
import type { ExecutableInvocation } from './protocol.ts'
import type { VirtualExecutableExit, VirtualExecutableRegistry } from './virtual-executables.ts'

/**
 * Validate a command request at the process-worker message boundary.
 * @param value - Untrusted invocation payload.
 * @returns Parsed argv, cwd, environment and pipeline input.
 */
export function parseExecutableInvocation(value: unknown): ExecutableInvocation {
  if (!value || typeof value !== 'object' || !('argv' in value) || !Array.isArray(value.argv)
    || value.argv.length === 0 || !value.argv.every((word: unknown) => typeof word === 'string' && !word.includes('\0'))
    || !('cwd' in value) || typeof value.cwd !== 'string' || !value.cwd.startsWith('/') || value.cwd.includes('\0')
    || !('stdin' in value) || typeof value.stdin !== 'string'
    || !('env' in value) || !value.env || typeof value.env !== 'object' || Array.isArray(value.env)) throw new Error('Invalid host executable request')
  const env: Record<string, string> = {}
  for (const [name, content] of Object.entries(value.env)) {
    if (!name || name.includes('\0') || name.includes('=') || typeof content !== 'string' || content.includes('\0')) throw new Error('Invalid host executable environment')
    Object.defineProperty(env, name, { value: content, enumerable: true, writable: true, configurable: true })
  }
  return { argv: value.argv as string[], cwd: value.cwd, stdin: value.stdin, env }
}

/**
 * Validate command output before handing it to shell redirection or pipelines.
 * @param value - Untrusted host reply.
 * @returns A completed virtual command result.
 */
export function parseExecutableResult(value: unknown): VirtualExecutableExit {
  if (!value || typeof value !== 'object' || !('exitCode' in value) || typeof value.exitCode !== 'number' || !Number.isInteger(value.exitCode)
    || !('stdout' in value) || typeof value.stdout !== 'string' || !('stderr' in value) || typeof value.stderr !== 'string') throw new Error('Invalid host executable reply')
  return { kind: 'exit', exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr }
}

/**
 * Expose declared host capabilities as ordinary shell programs with ordinary ShellIo routing.
 * @param names - Allowed lifecycle-owned command names.
 * @param execute - Host executor or message-backed RPC adapter.
 * @returns Programs to merge into this shell invocation's command table.
 */
export function executablePrograms(
  names: readonly string[], execute: (invocation: ExecutableInvocation) => Promise<VirtualExecutableExit>,
): ReadonlyMap<string, ShellProgram> {
  return new Map(names.map<[string, ShellProgram]>(name => [name, async (argv, io, state) => {
    state.signal?.throwIfAborted()
    const result = await execute({ argv, cwd: state.cwd, env: state.environment, stdin: io.stdin })
    state.signal?.throwIfAborted()
    io.out(result.stdout)
    io.err(result.stderr)
    return result.exitCode
  }]))
}

/**
 * Execute only a command authorized when this process started, buffering its progress output.
 * @param registry - Running host's lifecycle-owned registrations.
 * @param allowed - Names offered to this process at startup.
 * @param invocation - Validated command invocation.
 * @param filesystem - This process's filesystem, including any existing confinement wrapper.
 * @param signal - Aborted on interruption, destruction or process exit.
 * @returns Buffered completion; platform delegation is deliberately unavailable through this RPC.
 */
export async function executeRegistered(
  registry: VirtualExecutableRegistry | undefined, allowed: ReadonlySet<string>, invocation: ExecutableInvocation,
  filesystem: ShellFileSystem, signal: AbortSignal,
): Promise<VirtualExecutableExit> {
  signal.throwIfAborted()
  const name = invocation.argv[0]
  const command = name !== undefined && allowed.has(name) && registry?.names().includes(name) ? registry.resolve(name) : undefined
  if (command === undefined) throw new Error('Host executable is not registered for this process')
  let stdout = ''
  let stderr = ''
  const result = await command.prepare(invocation.argv.slice(1), {
    cwd: invocation.cwd, env: invocation.env, stdin: invocation.stdin, filesystem, signal,
    output: (stream, text) => { if (stream === 'stdout') stdout += text; else stderr += text },
  })
  signal.throwIfAborted()
  if (result.kind !== 'exit') throw new Error('Host executable delegation is not supported inside the shell command RPC')
  return { kind: 'exit', exitCode: result.exitCode, stdout: stdout + result.stdout, stderr: stderr + result.stderr }
}
