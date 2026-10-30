const { execSync } = require('node:child_process');
const path = require('node:path');

function git(args, cwd) {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

// Worktrees share their main checkout's memory unless isolation is requested.
function getGitRoot(cwd) {
  const isolateWorktrees = process.env.SUPERMEMORY_ISOLATE_WORKTREES === 'true';

  try {
    if (isolateWorktrees) {
      return git('rev-parse --show-toplevel', cwd) || null;
    }

    const gitCommonDir = git('rev-parse --git-common-dir', cwd);
    if (gitCommonDir === '.git') {
      return git('rev-parse --show-toplevel', cwd) || null;
    }

    const resolved = path.resolve(cwd, gitCommonDir);
    if (
      path.basename(resolved) === '.git' &&
      !resolved.includes(`${path.sep}.git${path.sep}`)
    ) {
      return path.dirname(resolved);
    }

    return git('rev-parse --show-toplevel', cwd) || null;
  } catch {
    return null;
  }
}

module.exports = { getGitRoot };
