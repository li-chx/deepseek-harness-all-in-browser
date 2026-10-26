/**
 * The command table: every program name this shell can run. A browser worker
 * spawns no processes, so this table IS the machine's `/bin` — a name that is
 * not here reports `command not found`, exactly as a real shell would for a
 * binary that is not installed.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/shell/programs
 */

import type { ShellProgram } from '../types.ts'
import { BUILTIN_PROGRAMS } from './builtins.ts'
import { FILE_PROGRAMS } from './files.ts'
import { TEXT_PROGRAMS } from './text.ts'

let table: Map<string, ShellProgram> | undefined

/**
 * The standard command table, built once and shared by every command line.
 * @param additional - Host capabilities available to this invocation.
 * @returns the program table, keyed by command name.
 */
export function standardPrograms(additional?: ReadonlyMap<string, ShellProgram>): ReadonlyMap<string, ShellProgram> {
  table ??= new Map<string, ShellProgram>([
    ...Object.entries(BUILTIN_PROGRAMS),
    ...Object.entries(FILE_PROGRAMS),
    ...Object.entries(TEXT_PROGRAMS),
    ['which', (argv, io, state, fs) => which(standardPrograms())(argv, io, state, fs)],
  ])
  if (additional === undefined || additional.size === 0) return table
  const combined = new Map([...table, ...additional])
  combined.set('which', which(combined))
  return combined
}

/** Reports which of the requested names this shell can run. */
const which = (known: ReadonlyMap<string, ShellProgram>): ShellProgram => (argv, io) => {
  let status = 0
  for (const name of argv.slice(1)) {
    // Every program is built into the shell, so a known name reports itself
    // instead of a path that would not exist in the VFS.
    if (known.has(name)) {
      io.out(`${name}: shell built-in command\n`)
      continue
    }
    io.err(`which: no ${name} in the worker host command table\n`)
    status = 1
  }
  return status
}
